import { defineChain } from 'viem';

// Arc testnet — Circle's L1. USDC is the native gas token (6 decimals),
// also exposed at a fixed ERC-20 interface address.
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
export const ARC_DEFAULT_RPC = 'https://rpc.testnet.arc.network';
export const ARC_EXPLORER = 'https://testnet.arcscan.app';

export const arcTestnet = (rpcUrl?: string) =>
  defineChain({
    id: ARC_TESTNET_CHAIN_ID,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl ?? ARC_DEFAULT_RPC] } },
    blockExplorers: { default: { name: 'ArcScan', url: ARC_EXPLORER } },
    testnet: true,
  });

export const explorerTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;
export const explorerAddressUrl = (addr: string) => `${ARC_EXPLORER}/address/${addr}`;

// $4.20 for whole-cent amounts, $0.001 for sub-cent nanopayment fees.
export const microToUsd = (micro: number | bigint) => {
  const n = Number(micro);
  const decimals = n % 10_000 === 0 ? 2 : 6;
  return `$${(n / 1e6).toFixed(decimals)}`;
};
