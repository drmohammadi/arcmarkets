'use client';

import { useAccount, useReadContracts } from 'wagmi';
import { fpmmAbi, conditionalTokensAbi } from '@/lib/abis';

/**
 * The connected wallet's YES/NO share balances for one market.
 *
 * Two batched rounds: the FPMM's ERC-1155 position IDs, then the balances for
 * those IDs. Split because the second depends on the first.
 */
export function usePosition(
  fpmm: `0x${string}` | undefined,
  conditionalTokens: `0x${string}` | undefined
) {
  const { address } = useAccount();

  const { data: posIds } = useReadContracts({
    contracts: [
      { address: fpmm, abi: fpmmAbi, functionName: 'yesPositionId' as const },
      { address: fpmm, abi: fpmmAbi, functionName: 'noPositionId' as const },
    ],
    query: { enabled: !!fpmm },
  });

  const yesPosId = posIds?.[0]?.status === 'success' ? (posIds[0].result as bigint) : undefined;
  const noPosId = posIds?.[1]?.status === 'success' ? (posIds[1].result as bigint) : undefined;
  const ready = !!address && !!conditionalTokens && yesPosId !== undefined && noPosId !== undefined;

  const { data: balances, refetch } = useReadContracts({
    contracts: [
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf' as const,
        args: ready ? [address, yesPosId] : undefined,
      },
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf' as const,
        args: ready ? [address, noPosId] : undefined,
      },
    ],
    query: { enabled: ready },
  });

  const yesShares =
    balances?.[0]?.status === 'success' ? (balances[0].result as bigint) : BigInt(0);
  const noShares = balances?.[1]?.status === 'success' ? (balances[1].result as bigint) : BigInt(0);

  return {
    yesShares,
    noShares,
    hasPosition: yesShares > BigInt(0) || noShares > BigInt(0),
    refetch,
  };
}
