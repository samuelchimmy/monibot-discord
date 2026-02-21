/**
 * MoniBot Discord - Database Module
 * Handles profile lookups, command deduplication, and transaction logging
 */

import { createClient } from '@supabase/supabase-js';

let supabase;

export function initSupabase() {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log('✅ Supabase initialized [Discord Bot]');
}

export function getSupabase() {
  return supabase;
}

// ============ Profile Lookups ============

/**
 * Find a profile by Discord ID
 */
export async function getProfileByDiscordId(discordId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error fetching profile by Discord ID ${discordId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Find a profile by MoniTag
 */
export async function getProfileByMonitag(payTag) {
  const cleanTag = payTag.replace('@', '').toLowerCase();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('pay_tag', cleanTag)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error fetching profile by PayTag ${payTag}:`, error.message);
    return null;
  }
  return data;
}

// ============ Command Deduplication ============

/**
 * Check if a command has already been processed
 */
export async function isCommandProcessed(platform, messageId) {
  const { data, error } = await supabase
    .from('platform_commands')
    .select('id')
    .eq('platform', platform)
    .eq('platform_message_id', messageId)
    .maybeSingle();

  if (error) return false;
  return !!data;
}

/**
 * Log a platform command
 */
export async function logCommand({
  platform,
  platformMessageId,
  platformUserId,
  platformChannelId,
  platformServerId,
  commandType,
  commandText,
  parsedAmount,
  parsedRecipients,
  chain = 'base',
  status = 'pending',
  resultTxHash = null,
  errorReason = null,
  profileId = null,
}) {
  const { data, error } = await supabase
    .from('platform_commands')
    .upsert({
      platform,
      platform_message_id: platformMessageId,
      platform_user_id: platformUserId,
      platform_channel_id: platformChannelId,
      platform_server_id: platformServerId,
      command_type: commandType,
      command_text: commandText,
      parsed_amount: parsedAmount,
      parsed_recipients: parsedRecipients,
      chain,
      status,
      result_tx_hash: resultTxHash,
      error_reason: errorReason,
      profile_id: profileId,
      processed_at: status !== 'pending' ? new Date().toISOString() : null,
    }, { onConflict: 'platform,platform_message_id' })
    .select()
    .maybeSingle();

  if (error) {
    console.error('❌ Failed to log command:', error.message);
    return null;
  }
  return data;
}

/**
 * Update command status
 */
export async function updateCommandStatus(commandId, status, txHash = null, errorReason = null) {
  const update = { status, processed_at: new Date().toISOString() };
  if (txHash) update.result_tx_hash = txHash;
  if (errorReason) update.error_reason = errorReason;

  const { error } = await supabase
    .from('platform_commands')
    .update(update)
    .eq('id', commandId);

  if (error) {
    console.error(`❌ Failed to update command ${commandId}:`, error.message);
  }
}

/**
 * Mark command as replied
 */
export async function markCommandReplied(commandId) {
  const { error } = await supabase
    .from('platform_commands')
    .update({ replied_at: new Date().toISOString() })
    .eq('id', commandId);

  if (error) {
    console.error(`❌ Failed to mark command replied:`, error.message);
  }
}

// ============ Transaction Logging (shared ledger) ============

/**
 * Log to monibot_transactions for unified history
 */
export async function logMonibotTransaction({
  senderId,
  receiverId,
  amount,
  fee,
  txHash,
  campaignId = null,
  type,
  tweetId = null,
  payerPayTag = null,
  recipientPayTag = null,
  chain = 'base',
}) {
  const isError = txHash.startsWith('ERROR_');
  const status = isError ? 'failed' : 'completed';

  const { error } = await supabase
    .from('monibot_transactions')
    .insert({
      sender_id: senderId,
      receiver_id: receiverId,
      amount,
      fee,
      tx_hash: txHash,
      campaign_id: campaignId,
      type,
      tweet_id: tweetId,
      payer_pay_tag: payerPayTag,
      recipient_pay_tag: recipientPayTag,
      chain,
      status,
      replied: false,
      retry_count: 0,
    });

  if (error) {
    console.error('❌ Failed to log monibot transaction:', error.message);
  }
}

// ============ Discord Server Tracking ============

/**
 * Track a Discord server
 */
export async function upsertDiscordServer(guildId, guildName, ownerId, memberCount) {
  const { error } = await supabase
    .from('discord_servers')
    .upsert({
      guild_id: guildId,
      guild_name: guildName,
      owner_id: ownerId,
      member_count: memberCount,
      is_active: true,
    }, { onConflict: 'guild_id' });

  if (error) {
    console.error('❌ Failed to upsert Discord server:', error.message);
  }
}

/**
 * Mark server as inactive (bot was removed)
 */
export async function markServerInactive(guildId) {
  const { error } = await supabase
    .from('discord_servers')
    .update({ is_active: false })
    .eq('guild_id', guildId);

  if (error) {
    console.error('❌ Failed to mark server inactive:', error.message);
  }
}

// ============ Campaign Helpers ============

/**
 * Get active campaigns for a specific network
 */
export async function getActiveCampaigns(network = 'base') {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'active')
    .eq('network', network)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('❌ Error fetching campaigns:', error.message);
    return [];
  }
  return data || [];
}

// ============ Scheduled Jobs ============

/**
 * Create a scheduled job for deferred command execution
 */
export async function createScheduledJob({
  type,
  scheduledAt,
  payload,
  sourceAuthorId = null,
  sourceAuthorUsername = null,
  sourceTweetId = null,
}) {
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .insert({
      type,
      scheduled_at: scheduledAt,
      payload,
      status: 'pending',
      source_author_id: sourceAuthorId,
      source_author_username: sourceAuthorUsername,
      source_tweet_id: sourceTweetId,
    })
    .select()
    .maybeSingle();

  if (error) {
    console.error('❌ Failed to create scheduled job:', error.message);
    return null;
  }
  console.log(`✅ Scheduled job created: ${data.id} for ${scheduledAt}`);
  return data;
}

/**
 * Get pending scheduled jobs ready for execution
 */
export async function getPendingScheduledJobs() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now);

  if (error) {
    console.error('❌ Failed to fetch pending scheduled jobs:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Fetch recently completed or failed scheduled jobs for Discord notification.
 */
export async function getCompletedScheduledJobs() {
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .in('status', ['completed', 'failed'])
    .gte('started_at', twoMinAgo)
    .order('completed_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('❌ Failed to fetch completed jobs:', error.message);
    return [];
  }
  return (data || []).filter(j => j.payload?.platform === 'discord');
}
