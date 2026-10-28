import { Copy, Loader2, Lock, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { destinationForKind, kindLabel, parkSeed, type NavRow } from './handoff';
import { routeDescription, type RouteResult } from './routeApi';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { KIND_ICON, kindColorVar, kindTint } from '@/components/shared/kindColors';
import Modal from '@/components/shared/Modal';
import type { RoutePlan, Destination, BlockRowProps, PlanCaveatsProps, PlanCardProps, PanelBodyProps, DescribeItPanelProps } from './DescribeItPanel.types';
import { logger } from '@/utils/logger';

const CARD_CLASS = 'rounded-xl border border-[var(--border-default)] px-3.5 py-3';

const ERROR_TEXT: Record<string, string[]> = {
    no_text: ['studio.ai.err_no_text', 'Type a short description first.'],
    no_model: ['studio.ai.err_no_model', 'No AI model is set up yet, so nothing can be picked for you.'],
    ai_unusable: ['studio.ai.err_ai_unusable', 'That was not clear enough to pick a building block — describe it a little more concretely.'],
    rate_limited: ['studio.ai.err_rate_limited', 'That is a lot of requests in a row — wait a moment and try again.'],
    failed: ['studio.ai.err_failed', 'Could not read that just now. Try again.'],
    // Two answers from the server that both look like "no kind" and are NOT
    // (house rule 12: empty and unreadable must stay distinguishable).
    none_available: ['studio.ai.err_none_available', 'There is nothing here you can build yet — ask an admin what your workspace has switched on.'],
    gates_unreadable: ['studio.ai.err_gates_unreadable', 'We could not work out what you may build right now. Try again in a moment.'],
};

/**
 * Why no kind came out. The server sends `available` (what this reader may
 * build) and `undecided` (the kinds whose gate could not be read); an empty
 * `available` with a filled `undecided` is something other than an empty
 * `available` without one — and both are something other than "the AI chose
 * nothing".
 */
const noKindCode = (result: Extract<RouteResult, { ok: true }>) => {
    if (Array.isArray(result.available) && result.available.length === 0) {
        return result.undecided.length ? 'gates_unreadable' : 'none_available';
    }
    return 'ai_unusable';
};

function BlockRow({ kind, name, note, t }: BlockRowProps) {
    const Icon = kind ? KIND_ICON[kind] ?? null : null;
    const color = kindColorVar(kind);
    return (
        <li
            data-testid={`studio-ai-block-${kind}`}
            className="flex items-start gap-2 rounded-lg px-2 py-1.5"
            style={{ background: kindTint(kind, 8) }}
        >
            {Icon ? <Icon className="w-3.5 h-3.5 mt-[2px] flex-shrink-0" style={{ color }} strokeWidth={1.75} aria-hidden="true" /> : null}
            <span className="min-w-0">
                <span className="text-[12px] font-medium text-[var(--text-primary)]">
                    {kindLabel(kind, t)}
                    {name ? <span className="text-[var(--text-secondary)] font-normal">{` · ${name}`}</span> : null}
                </span>
                {note ? <span className="block text-[11px] text-[var(--text-tertiary)]">{note}</span> : null}
            </span>
        </li>
    );
}

function PlanCaveats({ plan, dest, blocked, copied, onCopy, t }: PlanCaveatsProps) {
    const undecided = Array.isArray(plan.undecided) ? plan.undecided : [];
    return (
        <>
            {undecided.length > 0 ? (
                // No singular/plural pair: the sentence lists names and does not change with
                // the count — the same consideration as
                // studio.attention.unavailable_named.
                <p data-testid="studio-ai-undecided" className="mt-2 text-[11.5px] text-[var(--text-secondary)]">
                    {t(
                        'studio.ai.undecided_named',
                        'We could not check every building block just now ({kinds}), so this choice was made from a shorter list than usual.',
                        { kinds: undecided.map((k) => kindLabel(k, t)).join(', ') },
                    )}
                </p>
            ) : null}
            {!blocked && dest && !dest.carriesName && plan.name ? (
                <p data-testid="studio-ai-name" className="mt-2 text-[11.5px] text-[var(--text-secondary)]">
                    {t('studio.ai.name_manual', 'The name does not travel along yet — give it this name in the builder that opens.')}
                </p>
            ) : null}
            {!blocked && dest && !dest.seedable ? (
                <div data-testid="studio-ai-seed" className="mt-2 rounded-lg border border-[var(--border-default)] px-2.5 py-2">
                    <p className="text-[11.5px] text-[var(--text-secondary)]">
                        {t('studio.ai.seed_manual', 'Your description does not travel along yet — paste it into the assistant of the builder that opens.')}
                    </p>
                    <p data-testid="studio-ai-seed-text" className="mt-1 text-[12px] text-[var(--text-primary)] whitespace-pre-wrap break-words">{plan.seed}</p>
                    <button
                        type="button"
                        data-testid="studio-ai-copy"
                        onClick={onCopy}
                        className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Copy className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                        {copied ? t('studio.ai.copied', 'Copied') : t('studio.ai.copy', 'Copy description')}
                    </button>
                </div>
            ) : null}
        </>
    );
}

function PlanCard({ plan, dest, blocked, busyRun, copied, errorLine, onConfirm, onBack, onCopy, t }: PlanCardProps) {
    const Icon = plan.kind ? KIND_ICON[plan.kind] ?? null : null;
    const color = kindColorVar(plan.kind);
    const title = plan.name
        ? t('studio.ai.plan_title', 'New {kind}: {name}', { kind: dest?.label || plan.kind, name: plan.name })
        : t('studio.ai.plan_title_unnamed', 'New {kind}', { kind: dest?.label || plan.kind });
    return (
        <div data-testid="studio-ai-plan" className={CARD_CLASS} style={{ background: kindTint(plan.kind, 4) }}>
            <div className="flex items-center gap-2">
                {Icon ? <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} strokeWidth={1.75} aria-hidden="true" /> : null}
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2>
            </div>
            <p className="mt-1 text-[11px] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
                {t('studio.ai.blocks', 'Building blocks')}
            </p>
            <ul className="mt-1 flex flex-col gap-1">
                <BlockRow kind={plan.kind} name={plan.name} note={null} t={t} />
                {plan.companions.map((c) => (
                    <BlockRow
                        key={c.kind}
                        kind={c.kind}
                        name={c.name}
                        note={t('studio.ai.companion_note', 'Shown for context — this version does not create it yet.')}
                        t={t}
                    />
                ))}
            </ul>
            {blocked ? (
                <p data-testid="studio-ai-lock" className="mt-2 flex items-start gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                    <Lock className="w-3.5 h-3.5 mt-[1px] flex-shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    {dest?.lockHint || t('studio.ai.unavailable', 'This building block is not available in your workspace.')}
                </p>
            ) : null}
            <PlanCaveats plan={plan} dest={dest} blocked={blocked} copied={copied} onCopy={onCopy} t={t} />
            {errorLine ? <p data-testid="studio-ai-error" className="mt-2 text-[11.5px] text-[var(--error)]">{errorLine}</p> : null}
            <div className="mt-2.5 flex items-center gap-2">
                <button
                    type="button"
                    data-testid="studio-ai-create"
                    onClick={onConfirm}
                    disabled={blocked || busyRun}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed [background:var(--accent-primary,#2563eb)]"
                >
                    {t('studio.ai.create', 'Make this')}
                </button>
                <button
                    type="button"
                    data-testid="studio-ai-other"
                    onClick={onBack}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)]"
                >
                    {t('studio.ai.other', 'Something else')}
                </button>
            </div>
        </div>
    );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function errorText(t: Translate, code: string): string {
    const [key, fallback] = ERROR_TEXT[code] ?? ERROR_TEXT.failed;
    return t(key, fallback);
}

function ErrorNote({ errorLine, errorCode, t }: { errorLine: string; errorCode: string | null; t: Translate }) {
    return (
        <p data-testid="studio-ai-error" className="mt-1.5 text-[11.5px] text-[var(--error)]">
            {errorLine}
            {errorCode === 'no_model' ? (
                <span className="text-[var(--text-tertiary)]">{` ${t('studio.ai.err_no_model_way_out', 'Pick a building block from New in the meantime.')}`}</span>
            ) : null}
        </p>
    );
}

function BusyRow({ onCancel, t }: { onCancel: () => void; t: Translate }) {
    return (
        <>
            <span data-testid="studio-ai-busy" className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                {t('studio.ai.busy', 'Reading your description…')}
            </span>
            <button
                type="button"
                data-testid="studio-ai-cancel"
                onClick={onCancel}
                className="h-8 px-3 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)]"
            >
                {t('studio.ai.cancel', 'Cancel')}
            </button>
        </>
    );
}

function PanelBody({ sections, onNavigate, user, onClose }: PanelBodyProps) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [phase, setPhase] = useState('idle'); // idle | busy | plan
    const [plan, setPlan] = useState<RoutePlan | null>(null);
    const [errorCode, setErrorCode] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [busyRun, setBusyRun] = useState(false);
    const abortRef = useRef<AbortController>(null);

    useEffect(() => () => { try { abortRef.current?.abort(); } catch (err) { logger.debug('al weg', err); } }, []);

    const submit = useCallback(async () => {
        if (!text.trim() || phase === 'busy') return;
        const controller = new AbortController();
        abortRef.current = controller;
        setErrorCode(null);
        setPhase('busy');
        let result: RouteResult;
        try {
            result = await routeDescription(text, { signal: controller.signal });
        } catch (err) {
            // Aborted — by the cancel button or by the fetch layer itself. No error on
            // the screen (the brief stays), but DO go back to the field: otherwise
            // "busy" hangs on a request that never answers again. A stale request
            // (a newer one is already running) leaves the state alone.
            if ((err as Error)?.name === 'AbortError') {
                if (abortRef.current === controller) setPhase('idle');
                return;
            }
            result = { ok: false, code: 'failed' };
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
        if (controller.signal.aborted) return;
        if (!result.ok) { setPhase('idle'); setErrorCode(result.code || 'failed'); return; }
        if (!result.kind) {
            // An answer without a kind is not a kind. Never a guess.
            setPhase('idle');
            setErrorCode(noKindCode(result));
            return;
        }
        setPlan({ ...result, seed: result.seed || text.trim() } as RoutePlan);
        setPhase('plan');
    }, [text, phase]);

    const cancel = useCallback(() => {
        try { abortRef.current?.abort(); } catch (err) { logger.debug('al weg', err); }
        abortRef.current = null;
        setPhase('idle');
    }, []);

    // "Something else": back to the field WITH the text in it. The brief may
    // never disappear through a button that means "no".
    const back = useCallback(() => { setPlan(null); setErrorCode(null); setPhase('idle'); }, []);

    const dest = plan ? destinationForKind(plan.kind, { sections, t }) : null;
    // The server should not send a kind this reader may not build; if the kind is
    // nevertheless not in its own `available` list, that counts. No list = unknown,
    // and then only the section brake decides.
    const serverExcludes = !!plan && Array.isArray(plan.available) && !plan.available.includes(plan.kind);
    const blocked = !!plan && (!dest?.available || serverExcludes);

    const confirm = useCallback(async () => {
        if (!plan || !dest || blocked || busyRun) return;
        setBusyRun(true);
        try {
            parkSeed(plan.kind, plan.seed);
            await dest.run({ onNavigate, t, user, name: plan.name, seed: plan.seed });
            onClose?.();
        } catch {
            setErrorCode('failed');
        } finally {
            setBusyRun(false);
        }
    }, [plan, dest, blocked, busyRun, onNavigate, t, user, onClose]);

    const copySeed = useCallback(async () => {
        try {
            await navigator?.clipboard?.writeText(plan?.seed || '');
            setCopied(true);
        } catch (err) { logger.debug('geen klembord: de tekst staat er zelf, selecteerbaar', err); }
    }, [plan]);

    const errorLine = errorCode ? errorText(t, errorCode) : null;

    if (phase === 'plan' && plan) {
        return (
            <PlanCard
                plan={plan}
                dest={dest}
                blocked={blocked}
                busyRun={busyRun}
                copied={copied}
                errorLine={errorLine}
                onConfirm={confirm}
                onBack={back}
                onCopy={copySeed}
                t={t}
            />
        );
    }

    const busy = phase === 'busy';
    return (
        <div className={CARD_CLASS} style={{ background: 'color-mix(in srgb, var(--type-ai) 4%, transparent)' }}>
            <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 flex-shrink-0 [color:var(--type-ai)]" strokeWidth={1.75} aria-hidden="true" />
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('studio.ai.describe_title', 'Describe what you want')}
                </h2>
            </div>
            <textarea
                data-testid="studio-ai-input"
                aria-label={t('studio.ai.describe_title', 'Describe what you want')}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                readOnly={busy}
                placeholder={t('studio.ai.placeholder', 'an agent that answers questions about our quotes, with the Quotes table as its knowledge')}
                className="mt-2 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-[12px] leading-[17px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--type-ai)]"
            />
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                {t('studio.ai.hint', 'The AI picks the building blocks and shows you the plan first.')}
            </p>
            {errorLine ? <ErrorNote errorLine={errorLine} errorCode={errorCode} t={t} /> : null}
            <div className="mt-2 flex items-center gap-2">
                <button
                    type="button"
                    data-testid="studio-ai-submit"
                    onClick={submit}
                    disabled={busy || !text.trim()}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed [background:var(--accent-primary,#2563eb)]"
                >
                    {t('studio.ai.submit', 'Show the plan')}
                </button>
                {busy ? <BusyRow onCancel={cancel} t={t} /> : null}
            </div>
        </div>
    );
}

export default function DescribeItPanel({
    sections, onNavigate, user = null, variant = 'inline', open = true, onClose = null,
}: DescribeItPanelProps) {
    const { t } = useTranslation();
    const body = (
        <PanelBody sections={sections} onNavigate={onNavigate} user={user} onClose={onClose} />
    );
    if (variant === 'modal') {
        return (
            <Modal
                open={open}
                onClose={onClose || (() => {})}
                title={t('studio.ai.title', 'Build with AI')}
                size="md"
            >
                <div data-testid="studio-ai-panel" data-variant="modal">{body}</div>
            </Modal>
        );
    }
    if (!open) return null;
    return <div data-testid="studio-ai-panel" data-variant="inline">{body}</div>;
}
