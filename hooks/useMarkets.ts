'use client';

import { useReadContract, useReadContracts, useChainId } from 'wagmi';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi } from '@/lib/abis';

export interface Market {
  questionId: bigint;
  fpmm: string;
  conditionId: string;
  question: string;
  category: string;
  resolutionTime: bigint;
  resolver: string;
  resolved: boolean;
}

/**
 * Fetch all markets by iterating questionId [0..nextQuestionId).
 * Uses useReadContracts (batched multicall) so the number of hooks is constant.
 */
export function useMarkets() {
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const factory = deployment?.marketFactory as `0x${string}` | undefined;

  const { data: nextIdRaw, isLoading: loadingCount } = useReadContract({
    address: factory,
    abi: marketFactoryAbi,
    functionName: 'nextQuestionId',
    query: { enabled: !!factory },
  });

  const nextId = Number(nextIdRaw ?? BigInt(0));

  const { data: results, isLoading: loadingMarkets } = useReadContracts({
    contracts: Array.from({ length: nextId }, (_, i) => ({
      address: factory,
      abi: marketFactoryAbi,
      functionName: 'markets' as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: !!factory && nextId > 0 },
  });

  const markets: Market[] = (results ?? [])
    .map((r, idx) => {
      if (r.status !== 'success' || !r.result) return null;
      const [fpmm, conditionId, question, category, resolutionTime, resolver, resolved] =
        r.result as unknown as [string, string, string, string, bigint, string, boolean];
      return {
        questionId: BigInt(idx),
        fpmm,
        conditionId,
        question,
        category,
        resolutionTime,
        resolver,
        resolved,
      };
    })
    .filter((m): m is Market => m !== null);

  return { markets, isLoading: loadingCount || loadingMarkets };
}
