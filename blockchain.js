/**
 * MoniBot Discord - Blockchain Module
 * Reuses the same MoniBotRouter contracts as the Twitter bot.
 * Supports Base, BSC, and Tempo.
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import { base, bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ============ ERC-8021 Builder Code (Base Only) ============

const BUILDER_CODE = process.env.BUILDER_CODE || 'bc_qt9yxo1d';

function generateBuilderCodeSuffix() {
  const bytes = Buffer.from(BUILDER_CODE, 'utf8');
  const padded = Buffer.alloc(32);
  bytes.copy(padded);
  return `8021${padded.toString('hex')}8021`;
}

function appendBuilderCode(calldata) {
  if (!calldata || !calldata.startsWith('0x')) return calldata;
  return `${calldata}${generateBuilderCodeSuffix()}`;
}

// ============ Chain Configs ============

const CHAIN_CONFIGS = {
  base: {
    chain: base,
    rpcs: [process.env.BASE_RPC_URL, 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'].filter(Boolean),
    routerAddress: '0xbee37c2f3ce9a48d498fc0d47629a1e10356a516',
    tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    symbol: 'USDC',
    useBuilderCode: true,
  },
  bsc: {
    chain: bsc,
    rpcs: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'],
    routerAddress: '0x9eed16952d734dfc84b7c4e75e9a3228b42d832e',
    tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
    decimals: 18,
    symbol: 'USDT',
    useBuilderCode: false,
  },
  tempo: {
    chain: { id: 42431, name: 'Tempo Testnet', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } },
    rpcs: [process.env.TEMPO_RPC_URL, 'https://rpc.moderato.tempo.xyz'].filter(Boolean),
    routerAddress: '0x78a824fde7ee3e69b2e2ee52d1136eecd76749fc',
    tokenAddress: '0x20c0000000000000000000000000000000000001',
    decimals: 6,
    symbol: 'αUSD',
    useBuilderCode: false,
  },
};

// ============ MoniBotRouter ABI ============

const moniBotRouterAbi = [
  { name: 'executeP2P', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'tweetId', type: 'string' }], outputs: [{ name: 'success', type: 'bool' }] },
  { name: 'executeGrant', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'campaignId', type: 'string' }], outputs: [{ name: 'success', type: 'bool' }] },
  { name: 'getNonce', type: 'function', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'calculateFee', type: 'function', stateMutability: 'view', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: 'fee', type: 'uint256' }, { name: 'netAmount', type: 'uint256' }] },
];

// ============ Client Factory ============

// Track current RPC index per chain for failover
const rpcIndexes = { base: 0, bsc: 0, tempo: 0 };

function getClients(chainName) {
  const config = CHAIN_CONFIGS[chainName];
  if (!config) throw new Error(`Unsupported chain: ${chainName}`);

  const rpcIdx = Math.min(rpcIndexes[chainName] || 0, config.rpcs.length - 1);
  const rpc = config.rpcs[rpcIdx];

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(rpc, { retryCount: 3, retryDelay: 300 }),
  });

  const walletClient = createWalletClient({
    account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY),
    chain: config.chain,
    transport: http(rpc, { retryCount: 3, retryDelay: 300 }),
  });

  return { publicClient, walletClient, config };
}

function rotateRpc(chainName) {
  const config = CHAIN_CONFIGS[chainName];
  if (!config) return;
  if ((rpcIndexes[chainName] || 0) < config.rpcs.length - 1) {
    rpcIndexes[chainName] = (rpcIndexes[chainName] || 0) + 1;
    console.log(`  🔁 RPC failover [${chainName}] → ${config.rpcs[rpcIndexes[chainName]]}`);
  }
}

// ============ Core Functions ============

/**
 * Execute a P2P transfer via MoniBotRouter
 */
export async function executeP2P(fromAddress, toAddress, amount, commandId, chainName = 'base') {
  const { publicClient, walletClient, config } = getClients(chainName);
  const amountInUnits = parseUnits(amount.toFixed(config.decimals), config.decimals);

  // Pre-flight checks
  const [nonce, balance, allowance] = await Promise.all([
    publicClient.readContract({ address: config.routerAddress, abi: moniBotRouterAbi, functionName: 'getNonce', args: [fromAddress] }),
    publicClient.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [fromAddress] }),
    publicClient.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: 'allowance', args: [fromAddress, config.routerAddress] }),
  ]);

  if (balance < amountInUnits) {
    throw new Error(`ERROR_BALANCE:Has ${formatUnits(balance, config.decimals)}, needs ${amount}`);
  }
  if (allowance < amountInUnits) {
    throw new Error(`ERROR_ALLOWANCE:Approved ${formatUnits(allowance, config.decimals)}, needs ${amount}`);
  }

  // Calculate fee
  const [fee] = await publicClient.readContract({ address: config.routerAddress, abi: moniBotRouterAbi, functionName: 'calculateFee', args: [amountInUnits] });
  const feeAmount = parseFloat(formatUnits(fee, config.decimals));

  // Encode and execute
  let calldata = encodeFunctionData({
    abi: moniBotRouterAbi,
    functionName: 'executeP2P',
    args: [fromAddress, toAddress, amountInUnits, nonce, `discord_${commandId}`],
  });

  if (config.useBuilderCode) {
    calldata = appendBuilderCode(calldata);
  }

  const gas = await publicClient.estimateContractGas({
    address: config.routerAddress,
    abi: moniBotRouterAbi,
    functionName: 'executeP2P',
    args: [fromAddress, toAddress, amountInUnits, nonce, `discord_${commandId}`],
    account: walletClient.account?.address,
  });

  const hash = await walletClient.sendTransaction({
    to: config.routerAddress,
    data: calldata,
    gas: gas + gas / 5n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`ERROR_REVERTED:Transaction reverted on-chain (${hash})`);
  }
  return { hash, fee: feeAmount };
}

/**
 * Execute a grant via MoniBotRouter
 */
export async function executeGrant(toAddress, amount, campaignId, chainName = 'base') {
  const { publicClient, walletClient, config } = getClients(chainName);
  const amountInUnits = parseUnits(amount.toFixed(config.decimals), config.decimals);

  // Check contract balance
  const contractBalance = await publicClient.readContract({
    address: config.tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [config.routerAddress],
  });

  if (contractBalance < amountInUnits) {
    throw new Error(`ERROR_CONTRACT_BALANCE:Has ${formatUnits(contractBalance, config.decimals)}, needs ${amount}`);
  }

  const [fee] = await publicClient.readContract({ address: config.routerAddress, abi: moniBotRouterAbi, functionName: 'calculateFee', args: [amountInUnits] });
  const feeAmount = parseFloat(formatUnits(fee, config.decimals));

  let calldata = encodeFunctionData({
    abi: moniBotRouterAbi,
    functionName: 'executeGrant',
    args: [toAddress, amountInUnits, campaignId],
  });

  if (config.useBuilderCode) {
    calldata = appendBuilderCode(calldata);
  }

  const gas = await publicClient.estimateContractGas({
    address: config.routerAddress,
    abi: moniBotRouterAbi,
    functionName: 'executeGrant',
    args: [toAddress, amountInUnits, campaignId],
    account: walletClient.account?.address,
  });

  const hash = await walletClient.sendTransaction({
    to: config.routerAddress,
    data: calldata,
    gas: gas + gas / 5n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`ERROR_REVERTED:Transaction reverted on-chain (${hash})`);
  }
  return { hash, fee: feeAmount };
}

/**
 * Get token balance for an address
 */
export async function getBalance(address, chainName = 'base') {
  const { publicClient, config } = getClients(chainName);
  const balance = await publicClient.readContract({
    address: config.tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  return { balance: parseFloat(formatUnits(balance, config.decimals)), symbol: config.symbol };
}

/**
 * Get the user's current approved spending amount for the Router
 */
export async function getAllowance(address, chainName = 'base') {
  const { publicClient, config } = getClients(chainName);
  const allowance = await publicClient.readContract({
    address: config.tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address, config.routerAddress],
  });
  return parseFloat(formatUnits(allowance, config.decimals));
}

export { CHAIN_CONFIGS };
