'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { fpmmAbi } from '@/lib/abis';
import { yesProbBps, poolLiquidity } from '@/lib/pricing';
import type { Market } from './useMarkets';

export interface Pool {
  reserveYes: bigint;
  reserveNo: bigint;
  /** Implied YES probability in bps (0..10000). */
  yesBps: number;
  /** Collateral backing the pool (the mergeable full-set amount). */
  liquidity: bigint;
  /** False when the reserves call failed or the pool is empty. */
  hasLiquidity: boolean;
}

const EMPTY_POOL: Pool = {
  reserveYes: BigInt(0),
  reserveNo: BigInt(0),
  yesBps: 5000,
  liquidity: BigInt(0),
  hasLiquidity: false,
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Batch-read live reserves for every supplied market via multicall, and derive
 * the implied probability + liquidity for each.
 *
 * Keyed by questionId string so callers don't depend on array index alignment,
 * which is fragile when a subset of calls fails.
 */
export function useMarketPools(markets: Market[]) {
  // Only query markets with a real FPMM address.
  const targets = useMemo(
    () => markets.filter((m) => !!m.fpmm && m.fpmm !== ZERO_ADDRESS),
    [markets]
  );

  const { data, isLoading, isError, refetch } = useReadContracts({
    contracts: targets.map((m) => ({
      address: m.fpmm as `0x${string}`,
      abi: fpmmAbi,
      functionName: 'reserves' as const,
    })),
    query: { enabled: targets.length > 0 },
  });

  const pools = useMemo(() => {
    const map = new Map<string, Pool>();
    targets.forEach((m, i) => {
      const entry = data?.[i];
      if (entry?.status !== 'success' || !entry.result) {
        map.set(m.questionId.toString(), EMPTY_POOL);
        return;
      }
      const [yes, no] = entry.result as unknown as [bigint, bigint];
      const total = yes + no;
      map.set(m.questionId.toString(), {
        reserveYes: yes,
        reserveNo: no,
        yesBps: yesProbBps(yes, no),
        liquidity: poolLiquidity(yes, no),
        hasLiquidity: total > BigInt(0),
      });
    });
    return map;
  }, [targets, data]);

  /** Safe accessor: always returns a Pool, never undefined. */
  function poolFor(questionId: bigint): Pool {
    return pools.get(questionId.toString()) ?? EMPTY_POOL;
  }

  return { pools, poolFor, isLoading, isError, refetch };
}
