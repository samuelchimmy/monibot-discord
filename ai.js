/**
 * MoniBot Discord - AI Module
 * 
 * Uses the monibot-ai edge function for:
 * - Natural language command parsing (NLP)
 * - Conversational chat responses
 * - Temporal expression parsing (scheduling)
 * 
 * Falls back to regex parsing if AI is unavailable.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Parse a natural language message into a structured command using AI.
 * Returns null if AI fails (caller should fall back to regex).
 */
export async function aiParseCommand(text, platform = 'discord') {
  try {
    const { data, error } = await supabase.functions.invoke('monibot-ai', {
      body: { action: 'parse-command', context: { text, platform } },
    });

    if (error) {
      console.error('[AI] Parse error:', error.message);
      return null;
    }

    if (data?.parsed) {
      console.log(`[AI] Parsed: ${JSON.stringify(data.parsed)}`);
      return data.parsed;
    }

    return null;
  } catch (e) {
    console.error('[AI] Parse exception:', e.message);
    return null;
  }
}

/**
 * Generate a conversational AI response for general questions.
 */
export async function aiChat(text, username, platform = 'discord') {
  try {
    const { data, error } = await supabase.functions.invoke('monibot-ai', {
      body: { action: 'chat', context: { text, platform, username } },
    });

    if (error) {
      console.error('[AI] Chat error:', error.message);
      return null;
    }

    return data?.text || null;
  } catch (e) {
    console.error('[AI] Chat exception:', e.message);
    return null;
  }
}

/**
 * Generate an AI-powered reply for a transaction result.
 */
export async function aiTransactionReply(txContext) {
  try {
    const { data, error } = await supabase.functions.invoke('monibot-ai', {
      body: { action: 'generate-reply', context: txContext },
    });

    if (error) return null;
    return data?.text || null;
  } catch {
    return null;
  }
}

/**
 * Parse temporal expressions from a message using AI.
 * Returns { hasSchedule, scheduledAt, command, timeDescription } or null on failure.
 */
export async function aiParseSchedule(text, platform = 'discord') {
  try {
    const { data, error } = await supabase.functions.invoke('monibot-ai', {
      body: { action: 'parse-schedule', context: { text, platform } },
    });

    if (error) {
      console.error('[AI] Schedule parse error:', error.message);
      return null;
    }

    return data?.parsed || null;
  } catch (e) {
    console.error('[AI] Schedule parse exception:', e.message);
    return null;
  }
}
