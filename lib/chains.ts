import { defineChain } from 'viem';

/**
 * Arc Testnet (Chain ID 5042002)
 * Circle's stablecoin L1. Native gas token is USDC (6 decimals, not 18).
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6, // CRITICAL: Arc native gas is 6-decimal USDC, not 18-decimal ETH
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.io'],
      webSocket: ['wss://rpc.testnet.arc.io'],
    },
    public: {
      http: ['https://rpc.testnet.arc.io'],
      webSocket: ['wss://rpc.testnet.arc.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan',
      url: 'https://testnet.arcscan.app',
    },
  },
  testnet: true,
});

/**
 * Arc Mainnet (placeholder — Circle has NOT published mainnet params yet).
 * This config is guarded: only used when ARC_MAINNET_CHAIN_ID env is set.
 * When Circle launches mainnet, update this with the real chain ID + RPC.
 */
export const arcMainnet = defineChain({
  id: parseInt(process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID || '0', 10) || 0,
  name: 'Arc Mainnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || ''],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan',
      url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL || '',
    },
  },
  testnet: false,
});

/**
 * The chain guard: only returns Arc mainnet if all three env vars are set.
 * Otherwise returns just the testnet.
 */
export function getConfiguredChains() {
  const mainnetReady =
    process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID &&
    process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL &&
    arcMainnet.id > 0;

  return mainnetReady ? [arcTestnet, arcMainnet] : [arcTestnet];
}
