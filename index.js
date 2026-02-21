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
import { aiParseCommand, aiChat, aiTransactionReply } from './ai.js';
import express from 'express';
import { initSupabase, getSupabase, getProfileByDiscordId, getProfileByMonitag, isCommandProcessed, logCommand, updateCommandStatus, logMonibotTransaction, upsertDiscordServer, markServerInactive, createScheduledJob, getCompletedScheduledJobs } from './database.js';
import { parseCommand, parseScheduleViaEdge, getTimeGreeting, getHelpContent, getSetupContent, getWelcomeContent } from './commands.js';
import { executeP2P, executeGrant, getBalance, CHAIN_CONFIGS } from './blockchain.js';
import { findAlternateChain } from './crossChainCheck.js';

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

// ============ Event: Ready ============

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`📡 Connected to ${c.guilds.cache.size} server(s)`);

  // Track all guilds
  c.guilds.cache.forEach(guild => {
    upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);
  });

  // Start scheduled job notification poller only after client is ready
  setInterval(pollScheduledJobResults, 30000);
  console.log('📡 Scheduled job notification poller started (30s interval)');

  // Clean up notified set every 10 min
  setInterval(() => { notifiedJobIds.clear(); }, 10 * 60 * 1000);
});

// ============ Event: Guild Join/Leave ============

client.on(Events.GuildCreate, (guild) => {
  console.log(`📥 Joined server: ${guild.name} (${guild.id})`);
  upsertDiscordServer(guild.id, guild.name, guild.ownerId, guild.memberCount);

  // Send welcome message to the system channel (or first available text channel)
  const targetChannel = guild.systemChannel || guild.channels.cache.find(
    ch => ch.type === 0 && ch.permissionsFor(guild.members.me)?.has('SendMessages')
  );

  if (targetChannel) {
    const welcomeContent = getWelcomeContent();
    const embed = new EmbedBuilder()
      .setTitle(welcomeContent.title)
      .setDescription(welcomeContent.description)
      .setColor(0x0052FF)
      .setFooter({ text: welcomeContent.footer });

    welcomeContent.fields.forEach(f => embed.addFields(f));
    targetChannel.send({ embeds: [embed] }).catch(err => {
      console.warn('⚠️ Could not send welcome message:', err.message);
    });
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
        await processingMsg.edit(`❌ Insufficient funds on ${command.chain}. You have **${alt.balance.toFixed(2)} ${alt.symbol}** on ${alt.chain.toUpperCase()} but need to set your allowance first at monipay.lovable.app → Settings → MoniBot AI.`);
        return;
      }
    }

    await updateCommandStatus(cmd?.id, 'failed', null, error.message.substring(0, 200));

    let errorMsg = '❌ Something went wrong processing your payment. Please try again.';
    if (error.message.includes('ERROR_BALANCE')) {
      const aiErr = await aiTransactionReply({ type: 'error_balance', sender: senderProfile.pay_tag, amount: command.amount });
      errorMsg = aiErr || 'Your balance is too low on all available chains to complete this payment. Please fund your wallet at monipay.lovable.app.';
    }
    if (error.message.includes('ERROR_ALLOWANCE')) {
      const aiErr = await aiTransactionReply({ type: 'error_allowance', sender: senderProfile.pay_tag, chain: command.chain });
      errorMsg = aiErr || 'You haven\'t approved MoniBot to spend your tokens yet. Head to monipay.lovable.app → Settings → MoniBot AI to set your allowance.';
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
        await reply.reply('❌ Giveaway paused — sender needs to set allowance at monipay.lovable.app → Settings → MoniBot AI.');
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
