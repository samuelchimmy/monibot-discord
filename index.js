/**
 * MoniBot Discord Bot v2.0
 *
 * Features:
 * - P2P payments via !monibot send $X to @tag
 * - Multi-send via !monibot send $X each to @a, @b, @c
 * - Giveaways via !monibot giveaway $X to the first N people
 * - Balance check via !monibot balance
 * - Time-aware greetings
 * - Multi-chain support (Base, BSC, Tempo)
 * - Guild tracking for analytics
 * - Automatic welcome message on server join/restart
 * - Scheduled job recovery notifications on restart
 * - Allowance sanity check before every payment
 * - Per-user rate limiting (max 5 commands/minute)
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, Events, AttachmentBuilder, PermissionsBitField } from 'discord.js';
import { aiParseCommand, aiChat, aiTransactionReply } from './ai.js';
import express from 'express';
import { initSupabase, getSupabase, getProfileByDiscordId, getProfileByMonitag, isCommandProcessed, logCommand, updateCommandStatus, logMonibotTransaction, upsertDiscordServer, markServerInactive, createScheduledJob, getCompletedScheduledJobs, getPendingScheduledJobs } from './database.js';
import { parseCommand, parseScheduleViaEdge, getTimeGreeting, getHelpContent, getSetupContent, getWelcomeContent } from './commands.js';
import { executeP2P, executeGrant, getBalance, getAllowance, CHAIN_CONFIGS } from './blockchain.js';
import { findAlternateChain } from './crossChainCheck.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MONIBOT_PROFILE_ID = process.env.MONIBOT_PROFILE_ID || '0cb9ca32-7ef2-4ced-8389-9dbca5156c94';

// ============ Explorer URLs ============

const EXPLORER_URLS = {
  base: 'https://basescan.org/tx/',
  bsc: 'https://bscscan.com/tx/',
  tempo: 'https://explore.tempo.xyz/tx/',
};

function getExplorerUrl(chain, txHash) {
  const base = EXPLORER_URLS[chain] || EXPLORER_URLS.base;
  return `${base}${txHash}`;
}

// ============ Express Health Check ============

const app = express();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'discord',
    guilds: client?.guilds?.cache?.size || 0,
    uptime: process.uptime(),
  });
});
app.listen(PORT, () => console.log(`🚀 Health server on port ${PORT}`));

// ============ Discord Client ============

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ============ Initialization ============

console.log('┌─────────────────────────────────────────────────┐');
console.log('│       MoniBot Discord Bot v2.0 (AI-Powered)     │');
console.log('│    NLP Commands + Conversational AI              │');
console.log('└─────────────────────────────────────────────────┘\n');

initSupabase();

// ============ Rate Limiter ============
// Tracks command timestamps per user. Max 5 commands per 60 seconds.

const userCommandTimestamps = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Returns { allowed: true } if the user is within the rate limit.
 * Returns { allowed: false, retryAfter } (seconds) if they are over it.
 * @param {string} userId
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = (userCommandTimestamps.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000);
    return { allowed: false, retryAfter };
  }

  timestamps.push(now);
  userCommandTimestamps.set(userId, timestamps);
  return { allowed: true };
}

// Clean up stale rate limit entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userCommandTimestamps.entries()) {
    const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) {
      userCommandTimestamps.delete(userId);
    } else {
      userCommandTimestamps.set(userId, fresh);
    }
  }
}, 5 * 60 * 1000);

// ============ Allowance Sanity Check ============

/**
 * Checks a user's on-chain allowance before a payment attempt.
 * Returns { ok: true } if allowance is sufficient.
 * Returns { ok: false, message } with a user-facing warning if it is not.
 *
 * Requires blockchain.js to export getAllowance(walletAddress, chain) → number.
 *
 * @param {string} walletAddress
 * @param {number} amount
 * @param {string} chain
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function checkAllowance(walletAddress, amount, chain) {
  try {
    const allowance = await getAllowance(walletAddress, chain);

    if (allowance < amount) {
      const chainLabel = chain.toUpperCase();
      const message =
        `⚠️ **Allowance too low on ${chainLabel}.**\n` +
        `Your current approved spending limit is **$${allowance.toFixed(2)}** but you're trying to send **$${amount.toFixed(2)}**.\n\n` +
        `Please increase your allowance at [monipay.xyz](https://monipay.xyz) → **Settings → MoniBot AI & Automation** before sending.`;
      return { ok: false, message };
    }

    return { ok: true };
  } catch (err) {
    // If the allowance check itself fails (e.g. RPC error), log and allow through —
    // the blockchain execution will catch the real on-chain error.
    console.warn(`⚠️ [Allowance] Could not check allowance for ${walletAddress} on ${chain}: ${err.message}`);
    return { ok: true };
  }
}

// ============ Welcome Message Helper ============

/**
 * Builds and sends the MoniBot welcome embed to the most appropriate channel in a guild.
 * Priority: systemChannel → #general/#welcome/#announcements → first writable text channel → DM to owner.
 * Always sends on bot restart (per product spec).
 *
 * @param {import('discord.js').Guild} guild
 */
async function sendWelcomeMessage(guild) {
  // ── Build the banner attachment ──────────────────────────────────────────
  const bannerPath = path.join(__dirname, 'assets', 'monibot_discord.png');
  let attachment = null;
  try {
    attachment = new AttachmentBuilder(bannerPath, { name: 'monibot_discord.png' });
  } catch (err) {
    console.warn(`⚠️ [Welcome] Could not load banner image: ${err.message}`);
  }

  // ── Build the embed ──────────────────────────────────────────────────────
  const welcomeEmbed = new EmbedBuilder()
    .setTitle('Thanks for adding MoniBot!')
    .setDescription(
      [
        '## Meet MoniBot',
        '**`MoniBot`** is Monipay\'s autonomous AI agent that transforms Discord into a payment-enabled platform.',
        '',
        '## Activate in 60 Seconds',
        '- Visit **[monipay.xyz](https://monipay.xyz)**',
        '- Create your MoniTag',
        '- Fund your monipay wallet via Cross-Chain Deposit into Base or BSC or direct stablecoin transfer into your monipay account (USDC on BASE & USDT on BSC)',
        '- Goto Settings - MoniBot AI & Automation',
        '- Link your discord account',
        '- Approve spending amount for the bot',
        '- Congratulations you are all set to send natural language commands on discord.',
        '',
        '## Example Commands',
        // Terminal-style coloured code block using Discord ANSI escape codes
        '```ansi',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33msend\u001b[0m \u001b[1;32m$50\u001b[0m \u001b[1;37mto\u001b[0m \u001b[1;35m@Jesse\u001b[0m',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33msend\u001b[0m \u001b[1;32m$50\u001b[0m \u001b[1;37mto the first person to drop their monitag below\u001b[0m',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33msend\u001b[0m \u001b[1;32m$50\u001b[0m \u001b[1;37meach to\u001b[0m \u001b[1;35m@Jesse\u001b[0m \u001b[1;37m&\u001b[0m \u001b[1;35m@jade\u001b[0m',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33msend\u001b[0m \u001b[1;32m$5\u001b[0m \u001b[1;37mto\u001b[0m \u001b[1;35m@Jesse\u001b[0m \u001b[1;37min\u001b[0m \u001b[1;31m5mins\u001b[0m',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33mbalance\u001b[0m',
        '\u001b[1;34m!\u001b[0m\u001b[1;36mmonibot\u001b[0m \u001b[1;33mhelp\u001b[0m',
        '```',
        '',
      ].join('\n')
    )
    .setColor(0x0066FF)
    .setURL('https://monipay.xyz')
    .setFooter({ text: 'Powered by MoniPay • monipay.xyz' });

  // Attach the banner image if it loaded successfully
  if (attachment) {
    welcomeEmbed.setImage('attachment://monibot_discord.png');
  }

  const messagePayload = attachment
    ? { embeds: [welcomeEmbed], files: [attachment] }
    : { embeds: [welcomeEmbed] };

  // ── Required permissions ─────────────────────────────────────────────────
  const REQUIRED_PERMS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ];

  /**
   * Returns true if the bot has all required permissions in the given channel.
   * @param {import('discord.js').GuildChannel} ch
   */
  function botCanPost(ch) {
    if (ch.type !== 0) return false; // text channels only
    const perms = ch.permissionsFor(guild.members.me);
    if (!perms) return false;
    return REQUIRED_PERMS.every(p => perms.has(p));
  }

  // ── Channel selection (priority order) ───────────────────────────────────

  // 1. System channel
  let targetChannel = null;
  if (guild.systemChannel && botCanPost(guild.systemChannel)) {
    targetChannel = guild.systemChannel;
    console.log(`[Welcome] Using system channel: #${guild.systemChannel.name}`);
  }

  // 2. Named fallback channels
  if (!targetChannel) {
    const preferredNames = ['general', 'welcome', 'announcements'];
    for (const name of preferredNames) {
      const found = guild.channels.cache.find(
        ch => ch.type === 0 && ch.name.toLowerCase().includes(name) && botCanPost(ch)
      );
      if (found) {
        targetChannel = found;
        console.log(`[Welcome] Using named fallback channel: #${found.name}`);
        break;
      }
    }
  }

  // 3. First writable text channel
  if (!targetChannel) {
    const firstAvailable = guild.channels.cache
      .filter(ch => botCanPost(ch))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .first();
    if (firstAvailable) {
      targetChannel = firstAvailable;
      console.log(`[Welcome] Using first available text channel: #${firstAvailable.name}`);
    }
  }

  // 4. Send to channel if found
  if (targetChannel) {
    try {
      await targetChannel.send(messagePayload);
      console.log(`✅ [Welcome] Message sent to #${targetChannel.name} in "${guild.name}" (${guild.id})`);
      return;
    } catch (err) {
      console.error(`❌ [Welcome] Failed to send to #${targetChannel.name}: ${err.message}`);
      // Fall through to DM the owner
    }
  }

  // 5. Last resort — DM the server owner
  console.warn(`⚠️ [Welcome] No accessible channel found in "${guild.name}". DMing owner...`);
  try {
    const owner = await guild.fetchOwner();
    const ownerEmbed = new EmbedBuilder()
      .setTitle('Thanks for adding MoniBot!')
      .setDescription(
        "**Heads up:** I couldn't find a channel to post in on your server. Please give MoniBot permission to send messages in at least one channel so I can greet your community!\n\n" +
        welcomeEmbed.data.description
      )
      .setColor(0x0066FF)
      .setFooter({ text: 'Powered by MoniPay • monipay.xyz' });

    const ownerPayload = attachment
      ? { embeds: [ownerEmbed], files: [attachment] }
      : { embeds: [ownerEmbed] };

    await owner.send(ownerPayload);
    console.log(`✅ [Welcome] DM sent to server owner: ${owner.user.tag}`);
  } catch (dmErr) {
    console.error(`❌ [Welcome] Could not DM server owner either: ${dmErr.message}`);
  }
}

// ============ Scheduled Job Recovery Notifier ============

/**
 * On bot restart, fetch all pending (not yet executed) scheduled jobs and
 * notify each job's channel that the bot is back online and the job is still queued.
 *
 * Requires `getPendingScheduledJobs` exported from database.js.
 * It should return jobs with status = 'pending' and scheduledAt in the future.
 */
async function notifyScheduledJobRecovery() {
  try {
    const pendingJobs = await getPendingScheduledJobs();
    if (!pendingJobs || pendingJobs.length === 0) {
      console.log('📋 [Recovery] No pending scheduled jobs to notify.');
      return;
    }

    console.log(`📋 [Recovery] Found ${pendingJobs.length} pending scheduled job(s). Sending recovery notices...`);

    for (const job of pendingJobs) {
      const channelId = job.payload?.channelId;
      if (!channelId) continue;

      const channel = client.channels.cache.get(channelId);
      if (!channel) {
        console.warn(`⚠️ [Recovery] Could not find channel ${channelId} for job ${job.id}`);
        continue;
      }

      const senderTag = job.payload?.senderPayTag || 'Unknown';
      const amount = job.payload?.command?.amount || job.payload?.amount || '?';
      const recipients = job.payload?.command?.recipients || job.payload?.recipients || [];
      const scheduledAt = job.scheduled_at ? new Date(job.scheduled_at) : null;
      const unixTs = scheduledAt ? Math.floor(scheduledAt.getTime() / 1000) : null;

      const embed = new EmbedBuilder()
        .setTitle('🔄 MoniBot is Back Online!')
        .setDescription(
          `Hey **@${senderTag}** — MoniBot just restarted, but don't worry: your scheduled payment is **still queued** and will execute as planned.`
        )
        .addFields(
          { name: '💸 Amount', value: `$${amount}`, inline: true },
          { name: '👤 To', value: recipients.map(r => `@${r}`).join(', ') || 'N/A', inline: true },
          {
            name: '⏰ Scheduled For',
            value: unixTs ? `<t:${unixTs}:F> (<t:${unixTs}:R>)` : 'Unknown',
            inline: false,
          },
          { name: '✅ Status', value: 'Queued — no action needed', inline: false },
        )
        .setColor(0x0052FF)
        .setFooter({ text: `Job ID: ${job.id} | Powered by MoniPay` });

      try {
        await channel.send({ embeds: [embed] });
        console.log(`📬 [Recovery] Notified channel ${channelId} for job ${job.id}`);
      } catch (sendErr) {
        console.error(`❌ [Recovery] Could not notify channel ${channelId} for job ${job.id}: ${sendErr.message}`);
      }
    }
  } catch (err) {
    console.error('❌ [Recovery] Failed to fetch pending scheduled jobs:', err.message);
  }
}

// ============ Event: Ready ============

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`📡 Connected to ${c.guilds.cache.size} server(s)`);

  // Track all guilds and send welcome on every restart (per spec)
  for (const guild of c.guilds.cache.values()) {
    upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);

    // Fetch full guild data (needed for systemChannel, members.me, etc.)
    try {
      const fullGuild = await guild.fetch();
      await sendWelcomeMessage(fullGuild);
    } catch (err) {
      console.error(`❌ [Welcome/Restart] Error for guild "${guild.name}": ${err.message}`);
    }
  }

  // Notify users with pending scheduled jobs that bot is back online
  await notifyScheduledJobRecovery();

  // Start scheduled job notification poller only after client is ready
  setInterval(pollScheduledJobResults, 30000);
  console.log('📡 Scheduled job notification poller started (30s interval)');

  // Clean up notified set every 10 min
  setInterval(() => { notifiedJobIds.clear(); }, 10 * 60 * 1000);
});

// ============ Event: Guild Join/Leave ============

client.on(Events.GuildCreate, async (guild) => {
  console.log(`📥 Joined server: ${guild.name} (${guild.id})`);
  upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);

  // Send welcome message (covers both first-join and rejoin)
  try {
    const fullGuild = await guild.fetch();
    await sendWelcomeMessage(fullGuild);
  } catch (err) {
    console.error(`❌ [Welcome/GuildCreate] Error for guild "${guild.name}": ${err.message}`);
  }
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`📤 Left server: ${guild.name} (${guild.id})`);
  markServerInactive(guild.id);
});

// ============ Event: Message ============

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and DMs
  if (message.author.bot) return;
  if (!message.guild) return;

  // Check for !monibot prefix or @mention
  const content = message.content.trim();
  const botMention = `<@${client.user.id}>`;

  if (!content.toLowerCase().startsWith('!monibot') && !content.startsWith(botMention)) return;

  // Remove prefix to get the actual message
  const cleaned = content.replace(/^!monibot\s*/i, '').replace(/<@!\d+>\s*/g, '').replace(/<@\d+>\s*/g, '').trim();
  if (!cleaned) return;

  // ── Rate limit check ────────────────────────────────────────────────────
  const rateCheck = checkRateLimit(message.author.id);
  if (!rateCheck.allowed) {
    await message.reply(
      `⏱️ **Slow down!** You're sending commands too fast. Please wait **${rateCheck.retryAfter}s** before trying again.\n` +
      `_(Limit: ${RATE_LIMIT_MAX} commands per minute)_`
    );
    return;
  }

  // Check for time-aware scheduling via edge function (supports complex expressions)
  const scheduleResult = await parseScheduleViaEdge(content, getSupabase());
  if (scheduleResult?.hasSchedule && scheduleResult.scheduledAt && scheduleResult.command) {
    await handleScheduledCommand(message, scheduleResult, cleaned);
    return;
  }

  // Try regex parsing first (fast path)
  let command = parseCommand(content);

  // If regex fails, try AI parsing (smart path)
  if (!command) {
    console.log(`[AI] Regex miss, trying NLP for: "${cleaned.substring(0, 80)}"`);
    const aiResult = await aiParseCommand(cleaned, 'discord');

    if (aiResult) {
      if (aiResult.type === 'chat' || aiResult.type === null) {
        await handleChat(message, cleaned);
        return;
      }
      command = {
        type: aiResult.type,
        amount: aiResult.amount,
        recipients: aiResult.recipients || [],
        chain: aiResult.chain || 'base',
        maxParticipants: aiResult.maxParticipants,
        raw: cleaned,
      };
      console.log(`[AI] Resolved to: ${command.type} | $${command.amount} | ${command.recipients?.join(', ') || 'n/a'}`);
    }
  }

  // Still nothing? Try conversational AI
  if (!command) {
    await handleChat(message, cleaned);
    return;
  }

  // Deduplication
  const alreadyProcessed = await isCommandProcessed('discord', message.id);
  if (alreadyProcessed) return;

  console.log(`\n📨 [Discord] Command from ${message.author.tag}: ${command.type} | ${content.substring(0, 80)}`);

  try {
    switch (command.type) {
      case 'help':
        await handleHelp(message);
        break;
      case 'setup':
        await handleSetup(message);
        break;
      case 'link':
        await handleLink(message);
        break;
      case 'balance':
        await handleBalance(message, command);
        break;
      case 'p2p':
        await handleP2P(message, command);
        break;
      case 'p2p_multi':
        await handleP2PMulti(message, command);
        break;
      case 'giveaway':
        await handleGiveaway(message, command);
        break;
      default:
        await handleChat(message, cleaned);
    }
  } catch (error) {
    console.error('❌ Command handler error:', error.message);
    await message.reply('❌ Something went wrong processing your command. Please try again.');
  }
});

// ============ Command Handlers ============

async function handleHelp(message) {
  const helpContent = getHelpContent();
  const embed = new EmbedBuilder()
    .setTitle(helpContent.title)
    .setDescription(helpContent.description)
    .setColor(0x0052FF)
    .setFooter({ text: helpContent.footer });

  helpContent.fields.forEach(f => embed.addFields(f));
  await message.reply({ embeds: [embed] });
}

async function handleSetup(message) {
  const setupContent = getSetupContent();
  const embed = new EmbedBuilder()
    .setTitle(setupContent.title)
    .setDescription(setupContent.description)
    .setColor(0x0052FF)
    .setFooter({ text: setupContent.footer });

  setupContent.fields.forEach(f => embed.addFields(f));
  await message.reply({ embeds: [embed] });
}

async function handleLink(message) {
  const profile = await getProfileByDiscordId(message.author.id);

  if (profile) {
    const embed = new EmbedBuilder()
      .setTitle('✅ Account Already Linked')
      .setDescription(`Your Discord is linked to **@${profile.pay_tag}**`)
      .setColor(0x00FF00);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🔗 Link Your MoniPay Account')
    .setDescription('Connect your Discord to your MoniPay wallet:')
    .addFields(
      { name: 'Step 1', value: 'Go to [monipay.xyz](https://monipay.xyz)', inline: false },
      { name: 'Step 2', value: 'Open **Settings** → **MoniBot AI**', inline: false },
      { name: 'Step 3', value: 'Click **Link Discord** and authorize', inline: false },
    )
    .setColor(0x0052FF)
    .setFooter({ text: 'One-time setup. Then use MoniBot in any server!' });

  await message.reply({ embeds: [embed] });
}

async function handleBalance(message, command) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
    return;
  }

  const chain = command.chain || senderProfile.preferred_network || 'base';
  const { balance, symbol } = await getBalance(senderProfile.wallet_address, chain);

  const embed = new EmbedBuilder()
    .setTitle('💰 Your Balance')
    .setDescription(`**${balance.toFixed(2)} ${symbol}** on ${chain.charAt(0).toUpperCase() + chain.slice(1)}`)
    .setColor(0x0052FF)
    .setFooter({ text: `@${senderProfile.pay_tag}` });

  await message.reply({ embeds: [embed] });
}

async function handleP2P(message, command) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
    return;
  }

  const recipientTag = command.recipients[0];
  const recipientProfile = await getProfileByMonitag(recipientTag);
  if (!recipientProfile) {
    await message.reply(`❌ MoniTag **@${recipientTag}** not found. They need to sign up at monipay.xyz`);
    return;
  }

  if (senderProfile.id === recipientProfile.id) {
    await message.reply('❌ You can\'t send to yourself.');
    return;
  }

  // ── Allowance sanity check ───────────────────────────────────────────────
  const allowanceCheck = await checkAllowance(senderProfile.wallet_address, command.amount, command.chain);
  if (!allowanceCheck.ok) {
    await message.reply(allowanceCheck.message);
    return;
  }

  // Log command
  const cmd = await logCommand({
    platform: 'discord',
    platformMessageId: message.id,
    platformUserId: message.author.id,
    platformChannelId: message.channel.id,
    platformServerId: message.guild.id,
    commandType: 'p2p',
    commandText: message.content,
    parsedAmount: command.amount,
    parsedRecipients: [recipientTag],
    chain: command.chain,
    status: 'processing',
    profileId: senderProfile.id,
  });

  const processingMsg = await message.reply(`⏳ Sending **$${command.amount}** to **@${recipientTag}** on ${command.chain}...`);

  let activeChain = command.chain;

  try {
    const { hash, fee } = await executeP2P(
      senderProfile.wallet_address,
      recipientProfile.wallet_address,
      command.amount,
      cmd?.id || message.id,
      activeChain
    );

    const chainConfig = CHAIN_CONFIGS[activeChain];
    const explorerUrl = getExplorerUrl(activeChain, hash);

    // Log to unified ledger
    await logMonibotTransaction({
      senderId: senderProfile.id,
      receiverId: recipientProfile.id,
      amount: command.amount,
      fee,
      txHash: hash,
      type: 'p2p_command',
      payerPayTag: senderProfile.pay_tag,
      recipientPayTag: recipientProfile.pay_tag,
      chain: activeChain.toUpperCase(),
    });

    await updateCommandStatus(cmd?.id, 'completed', hash);

    // Generate AI natural language reply
    const aiReply = await aiTransactionReply({
      type: 'p2p_success',
      amount: command.amount,
      fee,
      symbol: chainConfig.symbol,
      recipient: recipientProfile.pay_tag,
      sender: senderProfile.pay_tag,
      chain: activeChain,
      txHash: hash,
    });

    const description = aiReply || `Payment of $${command.amount.toFixed(2)} ${chainConfig.symbol} sent to @${recipientProfile.pay_tag}.`;

    const embed = new EmbedBuilder()
      .setTitle('✅ Payment Sent!')
      .setDescription(description)
      .addFields(
        { name: 'Amount', value: `$${command.amount.toFixed(2)} ${chainConfig.symbol}`, inline: true },
        { name: 'Fee', value: `$${fee.toFixed(4)}`, inline: true },
        { name: 'To', value: `@${recipientProfile.pay_tag}`, inline: true },
        { name: 'TX', value: `[View on Explorer](${explorerUrl})\n\`${hash}\``, inline: false },
      )
      .setColor(0x00FF00);

    await processingMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    console.error('❌ P2P execution error:', error.message);

    // Cross-chain fallback: if balance or allowance error, check other chains
    if (error.message.includes('ERROR_BALANCE') || error.message.includes('ERROR_ALLOWANCE')) {
      const alt = await findAlternateChain(senderProfile.wallet_address, command.amount, activeChain);

      if (alt && !alt.needsAllowance) {
        // Allowance check on the alternate chain before rerouting
        const altAllowanceCheck = await checkAllowance(senderProfile.wallet_address, command.amount, alt.chain);
        if (!altAllowanceCheck.ok) {
          await processingMsg.edit(
            `🔄 Tried to reroute to **${alt.chain.toUpperCase()}** but your allowance is too low there too.\n\n${altAllowanceCheck.message}`
          );
          await updateCommandStatus(cmd?.id, 'failed', null, 'Allowance too low on all chains');
          return;
        }

        // Auto-reroute to alternate chain
        await processingMsg.edit(`🔄 Insufficient funds on ${activeChain}. Rerouting to **${alt.chain.toUpperCase()}** (${alt.balance.toFixed(2)} ${alt.symbol})...`);
        activeChain = alt.chain;

        try {
          const { hash, fee } = await executeP2P(
            senderProfile.wallet_address,
            recipientProfile.wallet_address,
            command.amount,
            cmd?.id || message.id,
            activeChain
          );

          const chainConfig = CHAIN_CONFIGS[activeChain];
          const explorerUrl = getExplorerUrl(activeChain, hash);

          await logMonibotTransaction({
            senderId: senderProfile.id,
            receiverId: recipientProfile.id,
            amount: command.amount,
            fee,
            txHash: hash,
            type: 'p2p_command',
            payerPayTag: senderProfile.pay_tag,
            recipientPayTag: recipientProfile.pay_tag,
            chain: activeChain.toUpperCase(),
          });

          await updateCommandStatus(cmd?.id, 'completed', hash);

          const aiReply = await aiTransactionReply({
            type: 'p2p_rerouted',
            amount: command.amount,
            fee,
            symbol: chainConfig.symbol,
            recipient: recipientProfile.pay_tag,
            sender: senderProfile.pay_tag,
            chain: activeChain,
            originalChain: command.chain,
            txHash: hash,
          });

          const description = aiReply || `Smart-routed from ${command.chain} to ${activeChain.toUpperCase()}. $${command.amount.toFixed(2)} ${chainConfig.symbol} delivered to @${recipientProfile.pay_tag}.`;

          const embed = new EmbedBuilder()
            .setTitle('✅ Payment Sent! (Smart Routed)')
            .setDescription(description)
            .addFields(
              { name: 'Amount', value: `$${command.amount.toFixed(2)} ${chainConfig.symbol}`, inline: true },
              { name: 'Fee', value: `$${fee.toFixed(4)}`, inline: true },
              { name: 'To', value: `@${recipientProfile.pay_tag}`, inline: true },
              { name: 'Route', value: `${command.chain} → ${activeChain.toUpperCase()}`, inline: true },
              { name: 'TX', value: `[View on Explorer](${explorerUrl})\n\`${hash}\``, inline: false },
            )
            .setColor(0x00FF00);

          await processingMsg.edit({ content: null, embeds: [embed] });
          return;
        } catch (retryError) {
          console.error('❌ Cross-chain retry also failed:', retryError.message);
        }
      } else if (alt && alt.needsAllowance) {
        await updateCommandStatus(cmd?.id, 'failed', null, `Funds on ${alt.chain} but no allowance`);
        await processingMsg.edit(`❌ Insufficient funds on ${command.chain}. You have **${alt.balance.toFixed(2)} ${alt.symbol}** on ${alt.chain.toUpperCase()} but need to set your allowance first at monipay.xyz → Settings → MoniBot AI.`);
        return;
      }
    }

    await updateCommandStatus(cmd?.id, 'failed', null, error.message.substring(0, 200));

    let errorMsg = '❌ Something went wrong processing your payment. Please try again.';
    if (error.message.includes('ERROR_BALANCE')) {
      const aiErr = await aiTransactionReply({ type: 'error_balance', sender: senderProfile.pay_tag, amount: command.amount });
      errorMsg = aiErr || 'Your balance is too low on all available chains to complete this payment. Please fund your wallet at monipay.xyz.';
    }
    if (error.message.includes('ERROR_ALLOWANCE')) {
      const aiErr = await aiTransactionReply({ type: 'error_allowance', sender: senderProfile.pay_tag, chain: command.chain });
      errorMsg = aiErr || 'You haven\'t approved MoniBot to spend your tokens yet. Head to monipay.xyz → Settings → MoniBot AI to set your allowance.';
    }
    if (error.message.includes('ERROR_REVERTED')) {
      const aiErr = await aiTransactionReply({ type: 'error_reverted', sender: senderProfile.pay_tag, txHash: error.message });
      errorMsg = aiErr || 'Your transaction was submitted but reverted on-chain. This could be a nonce mismatch, duplicate transaction, or contract issue. Please try again.';
    }

    await processingMsg.edit(errorMsg);
  }
}

async function handleP2PMulti(message, command) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
    return;
  }

  // ── Allowance sanity check (total = per-person × recipient count) ─────────
  const totalAmount = command.amount * command.recipients.length;
  const allowanceCheck = await checkAllowance(senderProfile.wallet_address, totalAmount, command.chain);
  if (!allowanceCheck.ok) {
    await message.reply(allowanceCheck.message);
    return;
  }

  const processingMsg = await message.reply(`⏳ Sending **$${command.amount}** each to **${command.recipients.length}** recipients...`);

  const results = [];
  for (const tag of command.recipients) {
    const recipientProfile = await getProfileByMonitag(tag);
    if (!recipientProfile) {
      results.push({ tag, status: 'failed', reason: 'Not found' });
      continue;
    }

    let activeChain = command.chain;
    try {
      const { hash, fee } = await executeP2P(
        senderProfile.wallet_address,
        recipientProfile.wallet_address,
        command.amount,
        `${message.id}_${tag}`,
        activeChain
      );

      await logMonibotTransaction({
        senderId: senderProfile.id,
        receiverId: recipientProfile.id,
        amount: command.amount,
        fee,
        txHash: hash,
        type: 'p2p_command',
        payerPayTag: senderProfile.pay_tag,
        recipientPayTag: recipientProfile.pay_tag,
        chain: activeChain.toUpperCase(),
      });

      results.push({ tag, status: 'success', hash, chain: activeChain });
    } catch (error) {
      // Cross-chain fallback
      if (error.message.includes('ERROR_BALANCE') || error.message.includes('ERROR_ALLOWANCE')) {
        const alt = await findAlternateChain(senderProfile.wallet_address, command.amount, activeChain);
        if (alt && !alt.needsAllowance) {
          // Allowance check on the alternate chain
          const altAllowanceCheck = await checkAllowance(senderProfile.wallet_address, command.amount, alt.chain);
          if (altAllowanceCheck.ok) {
            try {
              const { hash, fee } = await executeP2P(
                senderProfile.wallet_address,
                recipientProfile.wallet_address,
                command.amount,
                `${message.id}_${tag}`,
                alt.chain
              );

              await logMonibotTransaction({
                senderId: senderProfile.id,
                receiverId: recipientProfile.id,
                amount: command.amount,
                fee,
                txHash: hash,
                type: 'p2p_command',
                payerPayTag: senderProfile.pay_tag,
                recipientPayTag: recipientProfile.pay_tag,
                chain: alt.chain.toUpperCase(),
              });

              results.push({ tag, status: 'success', hash, rerouted: `${activeChain}→${alt.chain}`, chain: alt.chain });
              continue;
            } catch (retryError) {
              results.push({ tag, status: 'failed', reason: retryError.message.split(':')[0] });
              continue;
            }
          }
        }
      }
      results.push({ tag, status: 'failed', reason: error.message.split(':')[0] });
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  const embed = new EmbedBuilder()
    .setTitle(`${successCount === results.length ? '✅' : '⚠️'} Multi-Send Results`)
    .setDescription(`${successCount}/${results.length} transfers completed`)
    .setColor(successCount === results.length ? 0x00FF00 : 0xFFA500);

  results.forEach(r => {
    const reroute = r.rerouted ? ` _(${r.rerouted})_` : '';
    const explorer = r.hash ? getExplorerUrl(r.chain || command.chain, r.hash) : '';
    embed.addFields({
      name: `@${r.tag}`,
      value: r.status === 'success' ? `✅ [View TX](${explorer})${reroute}\n\`${r.hash}\`` : `❌ ${r.reason}`,
      inline: true,
    });
  });

  await processingMsg.edit({ content: null, embeds: [embed] });
}

async function handleGiveaway(message, command) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
    return;
  }

  const totalBudget = command.amount * command.maxParticipants;

  // ── Allowance sanity check (total giveaway budget) ───────────────────────
  const allowanceCheck = await checkAllowance(senderProfile.wallet_address, totalBudget, command.chain);
  if (!allowanceCheck.ok) {
    await message.reply(allowanceCheck.message);
    return;
  }

  // Log the giveaway command
  await logCommand({
    platform: 'discord',
    platformMessageId: message.id,
    platformUserId: message.author.id,
    platformChannelId: message.channel.id,
    platformServerId: message.guild.id,
    commandType: 'giveaway',
    commandText: message.content,
    parsedAmount: command.amount,
    parsedRecipients: [],
    chain: command.chain,
    status: 'pending',
    profileId: senderProfile.id,
  });

  const embed = new EmbedBuilder()
    .setTitle('🎁 MoniBot Giveaway!')
    .setDescription(`**@${senderProfile.pay_tag}** is giving away **$${command.amount}** each to the first **${command.maxParticipants}** people!`)
    .addFields(
      { name: '💰 Per Person', value: `$${command.amount}`, inline: true },
      { name: '👥 Spots', value: `${command.maxParticipants}`, inline: true },
      { name: '💎 Total', value: `$${totalBudget.toFixed(2)}`, inline: true },
      { name: 'How to Claim', value: 'Drop your **@MoniTag** below! 👇', inline: false },
    )
    .setColor(0xFFD700)
    .setFooter({ text: 'First come, first served! Must have a MoniPay account.' });

  const giveawayMsg = await message.reply({ embeds: [embed] });

  // Create a collector for replies
  const filter = (m) => !m.author.bot && /@\w+/i.test(m.content);
  const collector = message.channel.createMessageCollector({ filter, time: 600000 }); // 10 min

  let claimedCount = 0;
  const claimedUsers = new Set();

  collector.on('collect', async (reply) => {
    if (claimedCount >= command.maxParticipants) {
      collector.stop('limit');
      return;
    }

    // Prevent duplicate claims
    if (claimedUsers.has(reply.author.id)) return;

    // Extract monitag from reply
    const tagMatch = reply.content.match(/@(\w[\w-]*)/);
    if (!tagMatch) return;

    const claimTag = tagMatch[1].toLowerCase();
    if (claimTag === 'monibot' || claimTag === 'monipay') return;

    const recipientProfile = await getProfileByMonitag(claimTag);
    if (!recipientProfile) {
      await reply.reply(`❌ @${claimTag} not found on MoniPay. Sign up at monipay.xyz first!`);
      return;
    }

    // Prevent self-giveaway
    if (recipientProfile.id === senderProfile.id) return;

    claimedUsers.add(reply.author.id);
    claimedCount++;

    try {
      const { hash, fee } = await executeP2P(
        senderProfile.wallet_address,
        recipientProfile.wallet_address,
        command.amount,
        `giveaway_${message.id}_${claimedCount}`,
        command.chain
      );

      await logMonibotTransaction({
        senderId: senderProfile.id,
        receiverId: recipientProfile.id,
        amount: command.amount,
        fee,
        txHash: hash,
        type: 'p2p_command',
        payerPayTag: senderProfile.pay_tag,
        recipientPayTag: recipientProfile.pay_tag,
        chain: command.chain.toUpperCase(),
      });

      const explorerUrl = getExplorerUrl(command.chain, hash);
      await reply.reply(`✅ **$${command.amount.toFixed(2)}** sent to **@${recipientProfile.pay_tag}**! (${claimedCount}/${command.maxParticipants})\n[View TX](${explorerUrl}) | \`${hash}\``);

      if (claimedCount >= command.maxParticipants) {
        collector.stop('limit');
      }
    } catch (error) {
      console.error(`❌ Giveaway transfer error for @${claimTag}:`, error.message);
      claimedUsers.delete(reply.author.id);
      claimedCount--;

      if (error.message.includes('ERROR_BALANCE')) {
        await reply.reply('❌ Giveaway ended — sender ran out of funds.');
        collector.stop('funds');
      } else if (error.message.includes('ERROR_ALLOWANCE')) {
        await reply.reply('❌ Giveaway paused — sender needs to set allowance at monipay.xyz → Settings → MoniBot AI.');
        collector.stop('allowance');
      } else if (error.message.includes('rate limit') || error.message.includes('429')) {
        await reply.reply('⏳ Network is busy — please try claiming again in a moment.');
      } else {
        await reply.reply('❌ Transfer failed — please try again.');
      }
    }
  });

  collector.on('end', (collected, reason) => {
    const endEmbed = new EmbedBuilder()
      .setTitle('🎁 Giveaway Ended!')
      .setDescription(`**${claimedCount}/${command.maxParticipants}** spots claimed.`)
      .setColor(reason === 'limit' ? 0x00FF00 : 0xFFA500)
      .setFooter({ text: reason === 'limit' ? 'All spots filled!' : reason === 'funds' ? 'Sender ran out of funds' : 'Time expired' });

    message.channel.send({ embeds: [endEmbed] });
  });
}

// ============ Scheduled Command Handler ============

async function handleScheduledCommand(message, scheduleResult, originalText) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
    return;
  }

  const scheduledAt = new Date(scheduleResult.scheduledAt);
  const now = new Date();

  if (scheduledAt <= now) {
    await message.reply('⏰ That time is in the past. Please specify a future time.');
    return;
  }

  // Parse the underlying command from the schedule result
  const innerCommand = parseCommand(`!monibot ${scheduleResult.command}`);
  let aiCommand = null;
  if (!innerCommand) {
    const aiResult = await aiParseCommand(scheduleResult.command, 'discord');
    if (aiResult && aiResult.type && aiResult.type !== 'chat') {
      aiCommand = aiResult;
    }
  }

  const cmd = innerCommand || aiCommand;
  if (!cmd || !cmd.type || cmd.type === 'help' || cmd.type === 'link' || cmd.type === 'balance') {
    await message.reply('❌ I can only schedule payment commands (send, giveaway). Try: `!monibot send $5 to @alice tomorrow at 3pm`');
    return;
  }

  // ── Allowance sanity check for scheduled commands ─────────────────────────
  // Warn the user now so they have time to fix it before execution.
  if (cmd.amount && cmd.chain) {
    const allowanceCheck = await checkAllowance(senderProfile.wallet_address, cmd.amount, cmd.chain);
    if (!allowanceCheck.ok) {
      await message.reply(
        `⚠️ **Heads up!** Your command has been queued, but:\n\n${allowanceCheck.message}\n\n` +
        `Please fix this before the scheduled time or the payment will fail.`
      );
    }
  }

  // Write to scheduled_jobs table
  const job = await createScheduledJob({
    type: cmd.type === 'giveaway' ? 'scheduled_giveaway' : 'scheduled_p2p',
    scheduledAt: scheduledAt.toISOString(),
    payload: {
      platform: 'discord',
      channelId: message.channel.id,
      guildId: message.guild.id,
      senderId: senderProfile.id,
      senderPayTag: senderProfile.pay_tag,
      senderWallet: senderProfile.wallet_address,
      command: cmd,
      originalText,
    },
    sourceAuthorId: message.author.id,
    sourceAuthorUsername: message.author.tag,
    sourceTweetId: message.id,
  });

  const timeDesc = scheduleResult.timeDescription || scheduledAt.toUTCString();

  const embed = new EmbedBuilder()
    .setTitle('⏰ Command Scheduled!')
    .setDescription(`Your command will execute at **${timeDesc}**`)
    .addFields(
      { name: 'Command', value: scheduleResult.command, inline: false },
      { name: 'Scheduled For', value: `<t:${Math.floor(scheduledAt.getTime() / 1000)}:F>`, inline: true },
      { name: 'Status', value: job ? '✅ Queued' : '❌ Failed to queue', inline: true },
    )
    .setColor(job ? 0x0052FF : 0xFF0000)
    .setFooter({ text: `Job ID: ${job?.id || 'N/A'}` });

  await message.reply({ embeds: [embed] });
}

// ============ Conversational AI Handler ============

async function handleChat(message, text) {
  try {
    await message.channel.sendTyping();
    const reply = await aiChat(text, message.author.username, 'discord');

    if (reply) {
      const embed = new EmbedBuilder()
        .setDescription(reply)
        .setColor(0x0052FF)
        .setFooter({ text: '🤖 MoniBot AI' });
      await message.reply({ embeds: [embed] });
    } else {
      await message.reply("I'm MoniBot! Try commands like `!monibot send $5 to @alice` or `!monibot help` 💸");
    }
  } catch (e) {
    console.error('[AI] Chat handler error:', e.message);
    await message.reply("I'm MoniBot! Try `!monibot help` to see what I can do 🤖");
  }
}

// ============ Scheduled Job Notification Poller ============

const notifiedJobIds = new Set();

async function pollScheduledJobResults() {
  try {
    const jobs = await getCompletedScheduledJobs();
    for (const job of jobs) {
      if (notifiedJobIds.has(job.id)) continue;
      notifiedJobIds.add(job.id);

      const channelId = job.payload?.channelId;
      if (!channelId) continue;

      const channel = client.channels.cache.get(channelId);
      if (!channel) continue;

      const senderTag = job.payload?.senderPayTag || 'Unknown';
      const recipients = job.payload?.command?.recipients || job.payload?.recipients || [];
      const amount = job.payload?.command?.amount || job.payload?.amount || '?';

      if (job.status === 'completed' && job.result) {
        const txHash = job.result.txHash || job.result.results?.[0]?.txHash;
        const chain = job.payload?.command?.chain || job.payload?.chain || 'base';
        const explorerUrl = getExplorerUrl(chain, txHash || '');

        const embed = new EmbedBuilder()
          .setTitle('⏰ Scheduled Payment Complete!')
          .setDescription(`**@${senderTag}**'s scheduled payment has been executed.`)
          .addFields(
            { name: 'Amount', value: `$${amount}`, inline: true },
            { name: 'To', value: recipients.map(r => `@${r}`).join(', ') || 'N/A', inline: true },
          )
          .setColor(0x00FF00)
          .setFooter({ text: `Job ID: ${job.id}` });

        if (txHash) {
          embed.addFields({ name: 'TX', value: `[View on Explorer](${explorerUrl})\n\`${txHash}\``, inline: false });
        }

        if (job.result.results) {
          const summary = job.result.results.map(r =>
            r.status === 'success' ? `✅ @${r.tag}` : `❌ @${r.tag}: ${r.reason}`
          ).join('\n');
          embed.addFields({ name: 'Results', value: summary, inline: false });
        }

        await channel.send({ embeds: [embed] });
        console.log(`📬 Notified channel ${channelId}: job ${job.id} completed`);
      } else if (job.status === 'failed') {
        const embed = new EmbedBuilder()
          .setTitle('❌ Scheduled Payment Failed')
          .setDescription(`**@${senderTag}**'s scheduled payment could not be executed.`)
          .addFields(
            { name: 'Amount', value: `$${amount}`, inline: true },
            { name: 'To', value: recipients.map(r => `@${r}`).join(', ') || 'N/A', inline: true },
            { name: 'Error', value: job.error_message?.substring(0, 200) || 'Unknown error', inline: false },
          )
          .setColor(0xFF0000)
          .setFooter({ text: `Job ID: ${job.id} | Attempts: ${job.attempts}/${job.max_attempts}` });

        await channel.send({ embeds: [embed] });
        console.log(`📬 Notified channel ${channelId}: job ${job.id} failed`);
      }
    }
  } catch (err) {
    console.error('❌ Job notification poll error:', err.message);
  }
}

// Poller started inside ClientReady event handler above

// Auto-restart removed — Railway handles container restarts via restart policy

// ============ Graceful Shutdown ============

process.on('SIGTERM', () => { console.log('🛑 SIGTERM'); client.destroy(); process.exit(0); });
process.on('SIGINT', () => { console.log('🛑 SIGINT'); client.destroy(); process.exit(0); });

// ============ Login ============

client.login(process.env.DISCORD_BOT_TOKEN);
