# MoniBot Discord Bot

Multi-chain payment bot for Discord servers. Supports Base (USDC), BSC (USDT), and Tempo (αUSD).

## Setup

### 1. Create Discord Application
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → Name it "MoniBot"
3. Go to **Bot** → Click **Add Bot**
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Copy the **Bot Token**

### 2. Invite Bot to Server
Use this URL (replace `CLIENT_ID`):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=2147483648&scope=bot
```

### 3. Environment Variables
Copy `.env.example` to `.env` and fill in:
```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
SUPABASE_URL=https://vdaeojxonqmzejwiioaq.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
MONIBOT_PRIVATE_KEY=your-executor-private-key
BASE_RPC_URL=https://mainnet.base.org
```

### 4. Deploy to Railway
```bash
railway init
railway up
```

## Commands

| Command | Description |
|---------|-------------|
| `!monibot send $5 to @alice` | Send payment |
| `!monibot send $1 each to @alice, @bob` | Multi-send |
| `!monibot giveaway $5 to the first 10` | Start giveaway |
| `!monibot balance` | Check balance |
| `!monibot link` | Link instructions |
| `!monibot help` | Show all commands |

### Network Selection
- Default: USDC on Base
- Add `usdt` for BSC: `!monibot send $5 usdt to @alice`
- Add `on tempo` for Tempo: `!monibot send $5 to @alice on tempo`

## Architecture
- **discord.js** for bot framework
- **viem** for blockchain interactions
- **Supabase** for profile lookup and transaction logging
- **90-minute auto-restart** for token refresh
