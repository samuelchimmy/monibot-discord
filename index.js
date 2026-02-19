/**
 * MoniBot Discord Bot v1.0
 * 
 * Features:
 * - P2P payments via !monibot send $X to @tag
 * - Multi-send via !monibot send $X each to @a, @b, @c
 * - Giveaways via !monibot giveaway $X to the first N people
 * - Balance check via !monibot balance
 * - Time-aware greetings
 * - Multi-chain support (Base, BSC, Tempo)
 * - Guild tracking for analytics
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, Events } from 'discord.js';
import { aiParseCommand, aiChat, aiParseSchedule } from './ai.js';
import express from 'express';
import { initSupabase, getProfileByDiscordId, getProfileByMonitag, isCommandProcessed, logCommand, updateCommandStatus, logMonibotTransaction, upsertDiscordServer, markServerInactive, createScheduledJob } from './database.js';
import { parseCommand, getTimeGreeting, getHelpContent } from './commands.js';
import { executeP2P, executeGrant, getBalance, CHAIN_CONFIGS } from './blockchain.js';

const PORT = process.env.PORT || 3000;
const MONIBOT_PROFILE_ID = process.env.MONIBOT_PROFILE_ID || '0cb9ca32-7ef2-4ced-8389-9dbca5156c94';

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

// ============ Event: Ready ============

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`📡 Connected to ${c.guilds.cache.size} server(s)`);

  // Track all guilds
  c.guilds.cache.forEach(guild => {
    upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);
  });
});

// ============ Event: Guild Join/Leave ============

client.on(Events.GuildCreate, (guild) => {
  console.log(`📥 Joined server: ${guild.name} (${guild.id})`);
  upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);
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

  // Check for time-aware scheduling first
  const scheduleResult = await aiParseSchedule(cleaned, 'discord');
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
      { name: 'Step 1', value: 'Go to [monipay.lovable.app](https://monipay.lovable.app)', inline: false },
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
    await message.reply(`❌ MoniTag **@${recipientTag}** not found. They need to sign up at monipay.lovable.app`);
    return;
  }

  if (senderProfile.id === recipientProfile.id) {
    await message.reply('❌ You can\'t send to yourself.');
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

  try {
    const { hash, fee } = await executeP2P(
      senderProfile.wallet_address,
      recipientProfile.wallet_address,
      command.amount,
      cmd?.id || message.id,
      command.chain
    );

    const netAmount = command.amount - fee;
    const chainConfig = CHAIN_CONFIGS[command.chain];

    // Log to unified ledger
    await logMonibotTransaction({
      senderId: senderProfile.id,
      receiverId: recipientProfile.id,
      amount: netAmount,
      fee,
      txHash: hash,
      type: 'p2p_command',
      payerPayTag: senderProfile.pay_tag,
      recipientPayTag: recipientProfile.pay_tag,
      chain: command.chain.toUpperCase(),
    });

    await updateCommandStatus(cmd?.id, 'completed', hash);

    const embed = new EmbedBuilder()
      .setTitle('✅ Payment Sent!')
      .setDescription(`${getTimeGreeting()}! Your payment went through.`)
      .addFields(
        { name: 'Amount', value: `$${netAmount.toFixed(2)} ${chainConfig.symbol}`, inline: true },
        { name: 'Fee', value: `$${fee.toFixed(4)}`, inline: true },
        { name: 'To', value: `@${recipientProfile.pay_tag}`, inline: true },
        { name: 'TX', value: `\`${hash.substring(0, 18)}...\``, inline: false },
      )
      .setColor(0x00FF00);

    await processingMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    console.error('❌ P2P execution error:', error.message);
    await updateCommandStatus(cmd?.id, 'failed', null, error.message.substring(0, 200));

    let errorMsg = '❌ Transaction failed.';
    if (error.message.includes('ERROR_BALANCE')) errorMsg = '❌ Insufficient balance.';
    if (error.message.includes('ERROR_ALLOWANCE')) errorMsg = '❌ Insufficient allowance to MoniBotRouter. Set your allowance at monipay.lovable.app → Settings → MoniBot AI.';

    await processingMsg.edit(errorMsg);
  }
}

async function handleP2PMulti(message, command) {
  const senderProfile = await getProfileByDiscordId(message.author.id);
  if (!senderProfile) {
    await message.reply('❌ Your Discord is not linked to MoniPay. Use `!monibot link` to connect.');
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

    try {
      const { hash, fee } = await executeP2P(
        senderProfile.wallet_address,
        recipientProfile.wallet_address,
        command.amount,
        `${message.id}_${tag}`,
        command.chain
      );

      await logMonibotTransaction({
        senderId: senderProfile.id,
        receiverId: recipientProfile.id,
        amount: command.amount - fee,
        fee,
        txHash: hash,
        type: 'p2p_command',
        payerPayTag: senderProfile.pay_tag,
        recipientPayTag: recipientProfile.pay_tag,
        chain: command.chain.toUpperCase(),
      });

      results.push({ tag, status: 'success', hash });
    } catch (error) {
      results.push({ tag, status: 'failed', reason: error.message.split(':')[0] });
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  const embed = new EmbedBuilder()
    .setTitle(`${successCount === results.length ? '✅' : '⚠️'} Multi-Send Results`)
    .setDescription(`${successCount}/${results.length} transfers completed`)
    .setColor(successCount === results.length ? 0x00FF00 : 0xFFA500);

  results.forEach(r => {
    embed.addFields({
      name: `@${r.tag}`,
      value: r.status === 'success' ? `✅ \`${r.hash.substring(0, 18)}...\`` : `❌ ${r.reason}`,
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
      await reply.reply(`❌ @${claimTag} not found on MoniPay. Sign up at monipay.lovable.app first!`);
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
        amount: command.amount - fee,
        fee,
        txHash: hash,
        type: 'p2p_command',
        payerPayTag: senderProfile.pay_tag,
        recipientPayTag: recipientProfile.pay_tag,
        chain: command.chain.toUpperCase(),
      });

      await reply.reply(`✅ **$${(command.amount - fee).toFixed(2)}** sent to **@${recipientProfile.pay_tag}**! (${claimedCount}/${command.maxParticipants})`);

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



setTimeout(() => {
  console.log('\n🔄 90-minute auto-restart...');
  process.exit(0);
}, 90 * 60 * 1000);

// ============ Graceful Shutdown ============

process.on('SIGTERM', () => { console.log('🛑 SIGTERM'); client.destroy(); process.exit(0); });
process.on('SIGINT', () => { console.log('🛑 SIGINT'); client.destroy(); process.exit(0); });

// ============ Login ============

client.login(process.env.DISCORD_BOT_TOKEN);
