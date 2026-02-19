/**
 * MoniBot Discord - Cross-Chain Balance Check
 * 
 * Checks all alternate chains for sufficient balance/allowance when
 * the requested chain has insufficient funds. Enables auto-rerouting.
 * Supports Base ↔ BSC ↔ Tempo fallback.
 */

import { createPublicClient, http, formatUnits, erc20Abi } from 'viem';
import { base, bsc } from 'viem/chains';

const CHAIN_CHECK_CONFIGS = {
  base: {
    chain: base,
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    routerAddress: '0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516',
    decimals: 6,
    symbol: 'USDC',
  },
  bsc: {
    chain: bsc,
    rpcs: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'],
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    routerAddress: '0x9EED16952D734dFC84b7C4e75e9A3228B42D832E',
    decimals: 18,
    symbol: 'USDT',
  },
  tempo: {
    chain: { id: 42431, name: 'Tempo Testnet', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } },
    rpcs: ['https://rpc.moderato.tempo.xyz'],
    tokenAddress: '0x20c0000000000000000000000000000000000001',
    routerAddress: '0x78A824fDE7Ee3E69B2e2Ee52d1136EECD76749fc',
    decimals: 6,
    symbol: 'αUSD',
  },
};

/**
 * Check balance and allowance on a specific chain.
 */
async function checkChainFunds(walletAddress, amount, chainName) {
  const config = CHAIN_CHECK_CONFIGS[chainName];
  if (!config) return { hasBalance: false, hasAllowance: false, balance: 0, allowance: 0, chain: chainName };

  for (const rpc of config.rpcs) {
    try {
      const client = createPublicClient({
        chain: config.chain,
        transport: http(rpc, { retryCount: 2, retryDelay: 500 }),
      });

      const [balance, allowance] = await Promise.all([
        client.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] }),
        client.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: 'allowance', args: [walletAddress, config.routerAddress] }),
      ]);

      const balanceNum = parseFloat(formatUnits(balance, config.decimals));
      const allowanceNum = parseFloat(formatUnits(allowance, config.decimals));

      return {
        hasBalance: balanceNum >= amount,
        hasAllowance: allowanceNum >= amount,
        balance: balanceNum,
        allowance: allowanceNum,
        chain: chainName,
        symbol: config.symbol,
      };
    } catch (e) {
      console.warn(`  ⚠️ Cross-chain ${chainName} check failed (${rpc}): ${e.message}`);
    }
  }

  return { hasBalance: false, hasAllowance: false, balance: 0, allowance: 0, chain: chainName, symbol: config.symbol };
}

/**
 * Find the best alternate chain that has both sufficient balance AND allowance.
 * Returns the chain name or null if none found.
 * 
 * @param {string} walletAddress
 * @param {number} amount
 * @param {string} currentChain - The chain that failed
 * @returns {Promise<{chain: string, balance: number, symbol: string}|null>}
 */
export async function findAlternateChain(walletAddress, amount, currentChain) {
  const alternates = Object.keys(CHAIN_CHECK_CONFIGS).filter(c => c !== currentChain);

  console.log(`  🔄 Cross-chain check: looking for $${amount} on ${alternates.join(', ')}...`);

  const checks = await Promise.all(
    alternates.map(chain => checkChainFunds(walletAddress, amount, chain))
  );

  // Prefer chains with both balance AND allowance
  const viable = checks.find(c => c.hasBalance && c.hasAllowance);
  if (viable) {
    console.log(`  ✅ Found funds on ${viable.chain}: ${viable.balance.toFixed(2)} ${viable.symbol} (allowance OK)`);
    return { chain: viable.chain, balance: viable.balance, symbol: viable.symbol };
  }

  // If balance exists but no allowance, still report it (user needs to approve)
  const hasBalanceOnly = checks.find(c => c.hasBalance && !c.hasAllowance);
  if (hasBalanceOnly) {
    console.log(`  ⚠️ Found balance on ${hasBalanceOnly.chain} but no allowance`);
    return { chain: hasBalanceOnly.chain, balance: hasBalanceOnly.balance, symbol: hasBalanceOnly.symbol, needsAllowance: true };
  }

  console.log(`  ❌ No alternate chain has sufficient funds`);
  return null;
}
