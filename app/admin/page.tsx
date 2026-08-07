'use client';

import { useState } from 'react';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { Header } from '@/components/Header';
import { LiquidityForm } from '@/components/LiquidityForm';
import { useMarkets } from '@/hooks/useMarkets';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi, erc20Abi } from '@/lib/abis';
import { sanitizeText, safeAddress } from '@/lib/sanitize';

export default function AdminPage() {
  const { address } = useAccount();
  const deployment = getDeployment(useChainId());

  const { data: owner } = useReadContract({
    address: deployment?.marketFactory as `0x${string}` | undefined,
    abi: marketFactoryAbi,
    functionName: 'owner',
    query: { enabled: !!deployment },
  });

  const isOwner = address && owner && address.toLowerCase() === (owner as string).toLowerCase();
  const { markets } = useMarkets();
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txWaiting } = useWaitForTransactionReceipt({ hash: txHash });

  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('');
  const [resolveDays, setResolveDays] = useState('7');
  const [resolver, setResolver] = useState('');
  const [fee, setFee] = useState('200');
  const [error, setError] = useState('');

  function handleCreate() {
    if (!deployment?.marketFactory || !question || !resolver) {
      setError('Fill all fields');
      return;
    }
    // Guard every numeric/address input: BigInt(NaN) throws, and an unguarded
    // throw here would escape the click handler as an unhandled rejection.
    const days = Number(resolveDays);
    if (!Number.isInteger(days) || days < 1) {
      setError('Days until resolution must be a whole number of at least 1');
      return;
    }
    const feeBps = Number(fee);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
      setError('Fee must be a whole number between 0 and 1000 bps');
      return;
    }
    const resolverAddr = safeAddress(resolver);
    if (!resolverAddr) {
      setError('Resolver must be a valid 0x address');
      return;
    }
    setError('');
    const nowSec = Math.floor(Date.now() / 1000);
    const resolutionTime = nowSec + days * 86400;
    writeContract(
      {
        address: deployment.marketFactory,
        abi: marketFactoryAbi,
        functionName: 'createMarket',
        args: [question, category, BigInt(resolutionTime), resolverAddr, BigInt(feeBps)],
      },
      {
        onSuccess: () => {
          setQuestion('');
          setCategory('');
          setResolver('');
        },
        onError: (err) => setError(sanitizeText(err.message) || 'Create failed'),
      }
    );
  }

  function handleResolve(questionId: bigint, yesWins: boolean) {
    if (!deployment?.marketFactory) return;
    setError('');
    const payouts: [bigint, bigint] = yesWins ? [BigInt(1), BigInt(0)] : [BigInt(0), BigInt(1)];
    writeContract(
      {
        address: deployment.marketFactory,
        abi: marketFactoryAbi,
        functionName: 'resolveMarket',
        args: [questionId, payouts],
      },
      {
        onError: (err) => setError(sanitizeText(err.message) || 'Resolve failed'),
      }
    );
  }

  function handleFaucet() {
    if (!deployment?.collateralToken || !deployment.isMockUSDC) return;
    setError('');
    writeContract(
      {
        address: deployment.collateralToken as `0x${string}`,
        abi: erc20Abi,
        functionName: 'faucet',
      },
      {
        onError: (err) => setError(sanitizeText(err.message) || 'Faucet failed'),
      }
    );
  }

  const working = isPending || txWaiting;

  if (!isOwner) {
    return (
      <main className="min-h-screen">
        <Header />
        <div className="max-w-2xl mx-auto px-6 py-8">
          <p className="text-red-600">Admin access required. Connect as the factory owner.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Admin</h1>
          {deployment?.isMockUSDC && (
            <button
              onClick={handleFaucet}
              disabled={working}
              className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              title="Mint 1000 test USDC to your wallet"
            >
              {working ? '…' : 'Get 1000 test USDC'}
            </button>
          )}
        </div>

        <section className="mb-8 p-6 border rounded-lg">
          <h2 className="font-bold mb-4">Create Market</h2>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Question (max 256 chars)"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              maxLength={256}
              disabled={working}
            />
            <input
              type="text"
              placeholder="Category (max 64 chars)"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              maxLength={64}
              disabled={working}
            />
            <input
              type="number"
              placeholder="Days until resolution"
              value={resolveDays}
              onChange={(e) => setResolveDays(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              disabled={working}
            />
            <input
              type="text"
              placeholder="Resolver address (0x...)"
              value={resolver}
              onChange={(e) => setResolver(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              disabled={working}
            />
            <input
              type="number"
              placeholder="Fee (bps, max 1000)"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              max={1000}
              disabled={working}
            />
            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={working}
              className="w-full py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {working ? 'Creating…' : 'Create Market'}
            </button>
          </div>
        </section>

        <section>
          <h2 className="font-bold mb-4">Manage Markets</h2>
          {markets.length === 0 && (
            <p className="text-gray-500">No markets yet. Create one above.</p>
          )}
          <ul className="space-y-4">
            {markets.map((m) => {
              const question = sanitizeText(m.question) || 'Untitled';
              const past = Date.now() / 1000 >= Number(m.resolutionTime);
              return (
                <li key={m.questionId.toString()} className="p-4 border rounded-lg">
                  <p className="font-medium mb-1">{question}</p>
                  <p className="text-xs text-gray-500 mb-3">
                    {m.resolved
                      ? 'Resolved'
                      : past
                        ? 'Open · ready to resolve'
                        : 'Open · locked until resolution time'}
                  </p>

                  {!m.resolved && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleResolve(m.questionId, true)}
                        disabled={working || !past}
                        className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                      >
                        YES wins
                      </button>
                      <button
                        onClick={() => handleResolve(m.questionId, false)}
                        disabled={working || !past}
                        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        NO wins
                      </button>
                    </div>
                  )}

                  {/* Fund the market's FPMM. Only useful before resolution. */}
                  {!m.resolved && deployment?.collateralToken && (
                    <LiquidityForm
                      fpmm={m.fpmm as `0x${string}`}
                      collateralToken={deployment.collateralToken as `0x${string}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}
