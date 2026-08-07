'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/Header';
import { LiquidityForm } from '@/components/LiquidityForm';
import { MarketImageUpload } from '@/components/MarketImageUpload';
import { Badge, EmptyState, ErrorNote } from '@/components/ui';
import { useMarkets } from '@/hooks/useMarkets';
import { useHiddenMarkets } from '@/hooks/useMarketImage';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi, erc20Abi } from '@/lib/abis';
import { sanitizeText, safeAddress } from '@/lib/sanitize';
import { hideMarket, unhideMarket } from '@/lib/hiddenMarkets';
import { parseQuestion } from '@/lib/eventGroups';

/** The contract limits are in BYTES, not characters. */
const MAX_QUESTION_BYTES = 256;
const MAX_CATEGORY_BYTES = 64;
const MAX_FEE_BPS = 1000;
/** Bound the outcome editor so one event can't queue an unbounded tx run. */
const MAX_OUTCOMES = 12;

const encoder = new TextEncoder();
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

interface OutcomeDraft {
  id: number;
  label: string;
}

export default function AdminPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { data: owner } = useReadContract({
    address: deployment?.marketFactory as `0x${string}` | undefined,
    abi: marketFactoryAbi,
    functionName: 'owner',
    query: { enabled: !!deployment },
  });

  const isOwner =
    !!address && !!owner && address.toLowerCase() === (owner as string).toLowerCase();

  const { markets } = useMarkets();
  const hidden = useHiddenMarkets();
  const { writeContractAsync } = useWriteContract();

  // Form state
  const [multi, setMulti] = useState(false);
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('');
  const [resolveDays, setResolveDays] = useState('7');
  const [resolver, setResolver] = useState('');
  const [fee, setFee] = useState('200');

  const nextOutcomeId = useRef(2);
  const [outcomes, setOutcomes] = useState<OutcomeDraft[]>([
    { id: 0, label: '' },
    { id: 1, label: '' },
  ]);

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** "Creating 2 of 3…" during a multi-outcome run. */
  const [progress, setProgress] = useState('');

  /** Refresh every contract read after a state-changing tx. */
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  // ── Outcome editor ─────────────────────────────────────────────────────────

  function addOutcome() {
    setOutcomes((prev) =>
      prev.length >= MAX_OUTCOMES ? prev : [...prev, { id: nextOutcomeId.current++, label: '' }]
    );
  }

  function removeOutcome(id: number) {
    // Keep at least two: a one-outcome "event" is just a binary market, and
    // lib/eventGroups deliberately refuses to group a lone market.
    setOutcomes((prev) => (prev.length <= 2 ? prev : prev.filter((o) => o.id !== id)));
  }

  function editOutcome(id: number, label: string) {
    setOutcomes((prev) => prev.map((o) => (o.id === id ? { ...o, label } : o)));
  }

  function moveOutcome(index: number, dir: -1 | 1) {
    setOutcomes((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  /**
   * Build the on-chain question strings for this form.
   *
   * Multi-outcome events are N independent binary markets sharing an event
   * title, per the "Event: Outcome" convention in lib/eventGroups — the
   * contracts are binary at every layer, so there is no N-outcome market to
   * create. Returns a typed error instead of throwing.
   */
  function buildQuestions(): { ok: true; questions: string[] } | { ok: false; error: string } {
    const title = question.trim();
    if (!title) return { ok: false, error: 'Enter a question or event title.' };

    if (!multi) {
      if (byteLength(title) > MAX_QUESTION_BYTES) {
        return { ok: false, error: `Question is too long (max ${MAX_QUESTION_BYTES} bytes).` };
      }
      return { ok: true, questions: [title] };
    }

    // parseQuestion splits on the FIRST colon, so a colon in the event title
    // would silently re-cut every question in the wrong place.
    if (title.includes(':')) {
      return {
        ok: false,
        error: 'Event title cannot contain a colon — it separates the title from the outcome.',
      };
    }

    const labels = outcomes.map((o) => o.label.trim()).filter((l) => l.length > 0);
    if (labels.length < 2) {
      return { ok: false, error: 'A multi-outcome event needs at least 2 named outcomes.' };
    }

    const seen = new Set<string>();
    for (const l of labels) {
      const key = l.toLowerCase();
      if (seen.has(key)) return { ok: false, error: `Duplicate outcome: "${l}".` };
      seen.add(key);
    }

    const questions = labels.map((l) => `${title}: ${l}`);
    for (const q of questions) {
      if (byteLength(q) > MAX_QUESTION_BYTES) {
        return {
          ok: false,
          error: `"${q}" exceeds ${MAX_QUESTION_BYTES} bytes. Shorten the title or outcome.`,
        };
      }
    }
    return { ok: true, questions };
  }

  async function handleCreate() {
    setError('');
    setNotice('');

    if (!deployment?.marketFactory) {
      setError('No factory deployed on this network.');
      return;
    }

    // Guard every numeric/address input: BigInt(NaN) throws, and an unguarded
    // throw here would escape the handler as an unhandled rejection.
    const days = Number(resolveDays);
    if (!Number.isInteger(days) || days < 1) {
      setError('Days until resolution must be a whole number of at least 1.');
      return;
    }
    const feeBps = Number(fee);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
      setError(`Fee must be a whole number between 0 and ${MAX_FEE_BPS} bps.`);
      return;
    }
    if (byteLength(category) > MAX_CATEGORY_BYTES) {
      setError(`Category is too long (max ${MAX_CATEGORY_BYTES} bytes).`);
      return;
    }
    const resolverAddr = safeAddress(resolver);
    if (!resolverAddr) {
      setError('Resolver must be a valid 0x address.');
      return;
    }

    const built = buildQuestions();
    if (!built.ok) {
      setError(built.error);
      return;
    }

    const resolutionTime = BigInt(Math.floor(Date.now() / 1000) + days * 86400);

    setBusy(true);
    let created = 0;
    try {
      // Sequential, not parallel: each outcome is its own createMarket call, and
      // they must be signed and mined in order to avoid nonce collisions. The
      // receipt wait between calls is what keeps the factory's questionId
      // counter consistent across the run.
      for (let i = 0; i < built.questions.length; i++) {
        setProgress(
          built.questions.length > 1 ? `Creating ${i + 1} of ${built.questions.length}…` : 'Creating…'
        );

        const hash = await writeContractAsync({
          address: deployment.marketFactory as `0x${string}`,
          abi: marketFactoryAbi,
          functionName: 'createMarket',
          args: [built.questions[i], category.trim(), resolutionTime, resolverAddr, BigInt(feeBps)],
        });

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }
        created++;
      }

      setQuestion('');
      setCategory('');
      setOutcomes([
        { id: nextOutcomeId.current++, label: '' },
        { id: nextOutcomeId.current++, label: '' },
      ]);
      setNotice(
        created > 1
          ? `Created ${created} markets. Add liquidity to each below so they can be traded.`
          : 'Market created. Add liquidity below so it can be traded.'
      );
      invalidate();
    } catch (err) {
      // Partial success is reported honestly: some markets may already exist.
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        (created > 0
          ? `Stopped after creating ${created} of ${built.questions.length}. `
          : '') + (sanitizeText(msg).slice(0, 200) || 'Create failed.')
      );
      if (created > 0) invalidate();
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  async function handleResolve(questionId: bigint, yesWins: boolean) {
    if (!deployment?.marketFactory) return;
    setError('');
    setNotice('');
    const payouts: [bigint, bigint] = yesWins ? [BigInt(1), BigInt(0)] : [BigInt(0), BigInt(1)];
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: deployment.marketFactory as `0x${string}`,
        abi: marketFactoryAbi,
        functionName: 'resolveMarket',
        args: [questionId, payouts],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setNotice(`Market #${questionId.toString()} resolved.`);
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(sanitizeText(msg).slice(0, 200) || 'Resolve failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFaucet() {
    if (!deployment?.collateralToken || !deployment.isMockUSDC) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: deployment.collateralToken as `0x${string}`,
        abi: erc20Abi,
        functionName: 'faucet',
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setNotice('Minted 1000 test USDC.');
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(sanitizeText(msg).slice(0, 200) || 'Faucet failed.');
    } finally {
      setBusy(false);
    }
  }

  const sortedMarkets = useMemo(
    () => [...markets].sort((a, b) => (a.questionId < b.questionId ? 1 : -1)),
    [markets]
  );

  if (!isOwner) {
    return (
      <main className="flex-1">
        <Header />
        <div id="main" className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          <EmptyState
            title="Admin access required"
            hint="Connect the wallet that owns the market factory to manage markets."
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-content sm:text-2xl">Admin</h1>
            <p className="mt-1 text-sm text-content-muted">
              Create, fund, resolve and curate markets.
            </p>
          </div>
          {deployment?.isMockUSDC && (
            <button
              type="button"
              onClick={() => void handleFaucet()}
              disabled={busy}
              className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content transition-colors hover:border-edge-strong disabled:opacity-50"
              title="Mint 1000 test USDC to your wallet"
            >
              Get 1000 test USDC
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4">
            <ErrorNote message={error} />
          </div>
        )}
        {notice && !error && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-yes/30 bg-yes-soft px-3 py-2 text-xs text-yes"
          >
            {notice}
          </p>
        )}

        {/* ── Create ──────────────────────────────────────────────────────── */}
        <section className="mb-8 rounded-card border border-edge bg-surface-raised p-5">
          <h2 className="text-sm font-semibold text-content">Create market</h2>

          <div
            role="group"
            aria-label="Market type"
            className="mt-3 flex gap-0.5 rounded-lg border border-edge p-0.5"
          >
            <TypeTab active={!multi} onClick={() => setMulti(false)} label="Single (Yes / No)" />
            <TypeTab active={multi} onClick={() => setMulti(true)} label="Multiple outcomes" />
          </div>

          {multi && (
            <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-2xs leading-relaxed text-content-muted">
              The contracts are binary, so each outcome is created as its own
              Yes/No market named <span className="font-medium text-content">Event: Outcome</span>{' '}
              and grouped in the UI — the same way Polymarket models multi-outcome events. This
              submits <span className="font-medium text-content">one transaction per outcome</span>.
            </p>
          )}

          <div className="mt-4 space-y-3">
            <Field
              label={multi ? 'Event title' : 'Question'}
              hint={
                multi
                  ? 'Shown as the event heading. Cannot contain a colon.'
                  : 'The full Yes/No question.'
              }
            >
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={multi ? 'US Election 2028' : 'Will BTC close above $100k in 2026?'}
                className={inputClass}
                disabled={busy}
              />
            </Field>

            {multi && (
              <fieldset className="rounded-lg border border-edge p-3">
                <legend className="px-1 text-xs font-medium text-content">
                  Outcomes
                  <span className="ml-1 font-normal text-content-subtle">
                    {outcomes.length}/{MAX_OUTCOMES}
                  </span>
                </legend>

                <ul className="space-y-2">
                  {outcomes.map((o, i) => (
                    <li key={o.id} className="flex items-center gap-1.5">
                      <span className="w-5 shrink-0 text-center text-2xs tabular-nums text-content-subtle">
                        {i + 1}
                      </span>
                      <input
                        type="text"
                        value={o.label}
                        onChange={(e) => editOutcome(o.id, e.target.value)}
                        placeholder={`Outcome ${i + 1}`}
                        aria-label={`Outcome ${i + 1}`}
                        className={inputClass}
                        disabled={busy}
                      />
                      <IconButton
                        label={`Move outcome ${i + 1} up`}
                        disabled={busy || i === 0}
                        onClick={() => moveOutcome(i, -1)}
                        glyph="M8 3.5 3.5 8m4.5-4.5L12.5 8M8 3.5v9"
                      />
                      <IconButton
                        label={`Move outcome ${i + 1} down`}
                        disabled={busy || i === outcomes.length - 1}
                        onClick={() => moveOutcome(i, 1)}
                        glyph="M8 12.5 3.5 8m4.5 4.5L12.5 8M8 12.5v-9"
                      />
                      <IconButton
                        label={`Remove outcome ${i + 1}`}
                        disabled={busy || outcomes.length <= 2}
                        onClick={() => removeOutcome(o.id)}
                        glyph="M4 4l8 8M12 4l-8 8"
                      />
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={addOutcome}
                  disabled={busy || outcomes.length >= MAX_OUTCOMES}
                  className="mt-2 rounded-lg border border-edge px-2.5 py-1 text-2xs font-medium text-content transition-colors hover:border-edge-strong disabled:opacity-40"
                >
                  + Add outcome
                </button>
              </fieldset>
            )}

            <Field label="Category" hint="Free text; the UI maps it to a canonical bucket.">
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Crypto"
                className={inputClass}
                disabled={busy}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Days until resolution">
                <input
                  type="number"
                  min={1}
                  value={resolveDays}
                  onChange={(e) => setResolveDays(e.target.value)}
                  className={inputClass}
                  disabled={busy}
                />
              </Field>
              <Field label="Fee (bps)" hint={`0–${MAX_FEE_BPS}`}>
                <input
                  type="number"
                  min={0}
                  max={MAX_FEE_BPS}
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  className={inputClass}
                  disabled={busy}
                />
              </Field>
            </div>

            <Field label="Resolver address" hint="The only address allowed to resolve.">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={resolver}
                  onChange={(e) => setResolver(e.target.value)}
                  placeholder="0x…"
                  className={inputClass}
                  disabled={busy}
                />
                {address && (
                  <button
                    type="button"
                    onClick={() => setResolver(address)}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-edge px-2.5 text-2xs font-medium text-content transition-colors hover:border-edge-strong disabled:opacity-50"
                  >
                    Use mine
                  </button>
                )}
              </div>
            </Field>

            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy}
              className="h-10 w-full rounded-lg bg-brand text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? progress || 'Working…' : multi ? 'Create outcomes' : 'Create market'}
            </button>
          </div>
        </section>

        {/* ── Manage ──────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-content">
            Manage markets
            <span className="ml-1.5 font-normal tabular-nums text-content-subtle">
              {markets.length}
            </span>
          </h2>

          {markets.length === 0 ? (
            <EmptyState title="No markets yet" hint="Create one above to get started." />
          ) : (
            <ul className="space-y-3">
              {sortedMarkets.map((m) => (
                <MarketRow
                  key={m.questionId.toString()}
                  questionId={m.questionId}
                  fpmm={m.fpmm}
                  rawQuestion={m.question}
                  resolutionTime={m.resolutionTime}
                  resolved={m.resolved}
                  hidden={hidden.has(m.questionId.toString())}
                  chainId={chainId}
                  collateralToken={deployment?.collateralToken}
                  busy={busy}
                  onResolve={handleResolve}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

const inputClass =
  'h-9 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-content placeholder:text-content-subtle disabled:opacity-60';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-content">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-content-subtle">{hint}</span>}
    </label>
  );
}

function TypeTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'bg-content text-surface' : 'text-content-muted hover:text-content'
      }`}
    >
      {label}
    </button>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  glyph,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  glyph: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-edge text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:opacity-30"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        <path d={glyph} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** One market in the manage list: status, image, hide, resolve, liquidity. */
function MarketRow({
  questionId,
  fpmm,
  rawQuestion,
  resolutionTime,
  resolved,
  hidden,
  chainId,
  collateralToken,
  busy,
  onResolve,
}: {
  questionId: bigint;
  fpmm: string;
  rawQuestion: string;
  resolutionTime: bigint;
  resolved: boolean;
  hidden: boolean;
  chainId: number;
  collateralToken: string | undefined;
  busy: boolean;
  onResolve: (questionId: bigint, yesWins: boolean) => void;
}) {
  const [confirmingHide, setConfirmingHide] = useState(false);
  const title = sanitizeText(rawQuestion) || 'Untitled';
  const parsed = parseQuestion(rawQuestion);
  // Recomputed per render rather than held in state: this is a display-only
  // comparison, and putting Date.now() in state would need a timer to stay true.
  const past = Date.now() / 1000 >= Number(resolutionTime);

  return (
    <li className="rounded-card border border-edge bg-surface-raised p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-2xs tabular-nums text-content-subtle">#{questionId.toString()}</span>
        {resolved ? (
          <Badge tone="brand">Resolved</Badge>
        ) : past ? (
          <Badge tone="yes">Ready to resolve</Badge>
        ) : (
          <Badge tone="neutral">Open</Badge>
        )}
        {parsed.eventTitle && <Badge tone="neutral">Event outcome</Badge>}
        {hidden && <Badge tone="warn">Hidden</Badge>}
      </div>

      <p className="mb-3 text-sm font-medium leading-snug text-content">{title}</p>

      <div className="mb-3">
        <MarketImageUpload questionId={questionId} question={title} />
      </div>

      <div className="flex flex-wrap gap-2">
        {!resolved && (
          <>
            <button
              type="button"
              onClick={() => onResolve(questionId, true)}
              disabled={busy || !past}
              title={past ? undefined : 'Locked until the resolution time'}
              className="h-9 rounded-lg bg-yes px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              YES wins
            </button>
            <button
              type="button"
              onClick={() => onResolve(questionId, false)}
              disabled={busy || !past}
              title={past ? undefined : 'Locked until the resolution time'}
              className="h-9 rounded-lg bg-no px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              NO wins
            </button>
          </>
        )}

        {/*
         * "Hide", not "Delete". MarketFactory has no delete or archive function
         * and markets are enumerated 0..nextQuestionId, so removal would mean
         * redeploying the factory — abandoning every existing market and every
         * open position. Hiding filters the browsable list only; the market,
         * its pool and all positions stay on-chain and reachable by URL, so
         * holders can always still redeem. See lib/hiddenMarkets.ts.
         */}
        {hidden ? (
          <button
            type="button"
            onClick={() => unhideMarket(chainId, questionId)}
            className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content transition-colors hover:border-edge-strong"
          >
            Unhide
          </button>
        ) : confirmingHide ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                hideMarket(chainId, questionId);
                setConfirmingHide(false);
              }}
              className="h-9 rounded-lg bg-no px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              Confirm hide
            </button>
            <button
              type="button"
              onClick={() => setConfirmingHide(false)}
              className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content-muted transition-colors hover:text-content"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingHide(true)}
            title="Removes this market from the browsable list in this browser. Nothing on-chain changes."
            className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content"
          >
            Hide from list
          </button>
        )}
      </div>

      {confirmingHide && !hidden && (
        <p className="mt-2 text-2xs leading-relaxed text-content-muted">
          This only hides the market from the list in this browser. The market, its liquidity and
          every position remain on-chain, and holders can still open it directly to redeem.
        </p>
      )}

      {/* Fund the market's FPMM. Only useful before resolution. */}
      {!resolved && collateralToken && (
        <LiquidityForm
          fpmm={fpmm as `0x${string}`}
          collateralToken={collateralToken as `0x${string}`}
        />
      )}
    </li>
  );
}
