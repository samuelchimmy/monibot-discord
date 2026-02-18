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
    rpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    routerAddress: '0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    symbol: 'USDC',
    useBuilderCode: true,
  },
  bsc: {
    chain: bsc,
    rpc: 'https://bsc-dataseed.binance.org',
    routerAddress: '0x9EED16952D734dFC84b7C4e75e9A3228B42D832E',
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    symbol: 'USDT',
    useBuilderCode: false,
  },
  tempo: {
    chain: { id: 42431, name: 'Tempo Testnet', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } },
    rpc: process.env.TEMPO_RPC_URL || 'https://rpc.moderato.tempo.xyz',
    routerAddress: '0x78A824fDE7Ee3E69B2e2Ee52d1136EECD76749fc',
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

function getClients(chainName) {
  const config = CHAIN_CONFIGS[chainName];
  if (!config) throw new Error(`Unsupported chain: ${chainName}`);

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpc, { retryCount: 3, retryDelay: 300 }),
  });

  const walletClient = createWalletClient({
    account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY),
    chain: config.chain,
    transport: http(config.rpc, { retryCount: 3, retryDelay: 300 }),
  });

  return { publicClient, walletClient, config };
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

  await publicClient.waitForTransactionReceipt({ hash });
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

  await publicClient.waitForTransactionReceipt({ hash });
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

export { CHAIN_CONFIGS };
