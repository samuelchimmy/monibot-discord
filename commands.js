/**
 * MoniBot Discord - Command Parser
 * 
 * Parses Discord messages into structured commands.
 * Supports:
 * - !monibot send $5 to @alice
 * - !monibot send $1 each to @alice, @bob, @charlie
 * - !monibot giveaway $5 to the first 5 people who drop their monitag
 * - !monibot balance
 * - !monibot help
 * - !monibot link (show linking instructions)
 */

// ============ Command Patterns ============

// P2P: "send $5 to @alice" or "pay $5 to @alice"
const P2P_SINGLE = /(?:send|pay)\s+\$?([\d.]+)\s+(?:usdc|usdt|alphausd|αusd)?\s*(?:to\s+)?@(\w[\w-]*)/i;

// Multi-send: "send $1 each to @alice, @bob, @charlie"
const P2P_MULTI = /(?:send|pay)\s+\$?([\d.]+)\s*(?:usdc|usdt|alphausd|αusd)?\s*each\s+to\s+((?:@\w[\w-]*(?:\s*,?\s*)?)+)/i;

// Giveaway: "giveaway $5 to the first 5 people who drop their monitag"
const GIVEAWAY = /giveaway\s+\$?([\d.]+)\s*(?:usdc|usdt|alphausd|αusd)?\s*(?:to\s+)?(?:the\s+)?(?:first\s+)?(\d+)\s*(?:people|users|tags|monitags)?/i;

// Balance check
const BALANCE = /balance/i;

// Help
const HELP = /help/i;

// Link
const LINK = /link/i;

// Network detection
const BSC_KEYWORDS = ['usdt', 'bnb', 'bsc'];
const TEMPO_KEYWORDS = ['on tempo', 'tempo', 'alphausd', 'αusd'];

/**
 * Detect which chain the command targets
 */
function detectChain(text) {
  const lower = text.toLowerCase();
  if (TEMPO_KEYWORDS.some(kw => lower.includes(kw))) return 'tempo';
  if (BSC_KEYWORDS.some(kw => lower.includes(kw))) return 'bsc';
  return 'base';
}

/**
 * Extract @mentions from text
 */
function extractMoniTags(text) {
  const matches = text.match(/@(\w[\w-]*)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay' && m !== 'everyone' && m !== 'here');
}

/**
 * Parse a Discord message into a structured command
 * @param {string} text - Message content
 * @returns {object|null} Parsed command or null
 */
export function parseCommand(text) {
  // Remove the !monibot prefix (or @MoniBot mention)
  const cleaned = text.replace(/^!monibot\s*/i, '').replace(/<@!\d+>\s*/g, '').trim();

  if (!cleaned) return null;

  // Check giveaway first (most specific)
  const giveawayMatch = cleaned.match(GIVEAWAY);
  if (giveawayMatch) {
    return {
      type: 'giveaway',
      amount: parseFloat(giveawayMatch[1]),
      maxParticipants: parseInt(giveawayMatch[2]),
      chain: detectChain(cleaned),
      raw: cleaned,
    };
  }

  // Multi-send
  const multiMatch = cleaned.match(P2P_MULTI);
  if (multiMatch) {
    const recipients = extractMoniTags(multiMatch[2]);
    if (recipients.length > 0) {
      return {
        type: 'p2p_multi',
        amount: parseFloat(multiMatch[1]),
        recipients,
        chain: detectChain(cleaned),
        raw: cleaned,
      };
    }
  }

  // Single P2P
  const singleMatch = cleaned.match(P2P_SINGLE);
  if (singleMatch) {
    return {
      type: 'p2p',
      amount: parseFloat(singleMatch[1]),
      recipients: [singleMatch[2].toLowerCase()],
      chain: detectChain(cleaned),
      raw: cleaned,
    };
  }

  // Balance
  if (BALANCE.test(cleaned)) {
    return { type: 'balance', chain: detectChain(cleaned), raw: cleaned };
  }

  // Help
  if (HELP.test(cleaned)) {
    return { type: 'help', raw: cleaned };
  }

  // Link
  if (LINK.test(cleaned)) {
    return { type: 'link', raw: cleaned };
  }

  return null;
}

/**
 * Generate time-aware greeting based on UTC
 */
export function getTimeGreeting() {
  const hour = new Date().getUTCHours();
  if (hour < 12) return '🌅 GM';
  if (hour < 17) return '☀️ Good afternoon';
  if (hour < 21) return '🌆 Good evening';
  return '🌙 Late night';
}

/**
 * Build help embed content
 */
export function getHelpContent() {
  return {
    title: '🤖 MoniBot Commands',
    description: 'Instant crypto payments powered by MoniPay',
    fields: [
      {
        name: '💸 Send Payment',
        value: '`!monibot send $5 to @alice`\n`!monibot pay $10 to @bob`',
      },
      {
        name: '📤 Multi-Send',
        value: '`!monibot send $1 each to @alice, @bob, @charlie`',
      },
      {
        name: '🎁 Giveaway',
        value: '`!monibot giveaway $5 to the first 10 people who drop their monitag`',
      },
      {
        name: '💰 Check Balance',
        value: '`!monibot balance`',
      },
      {
        name: '🔗 Link Account',
        value: '`!monibot link` — Connect your Discord to MoniPay',
      },
      {
        name: '🌐 Networks',
        value: 'Add `usdt` for BSC, `on tempo` for Tempo.\nDefault: USDC on Base.',
      },
    ],
    footer: 'Link your account at monipay.lovable.app → Settings → MoniBot AI',
  };
}
