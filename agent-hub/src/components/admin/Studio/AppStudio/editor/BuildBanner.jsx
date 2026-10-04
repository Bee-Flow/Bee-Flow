import { Crosshair } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useBuildCue } from './BuildCueContext';
import useTranslation from '../../../../../hooks/useTranslation';
import { enginePill, engineSegments, showsRates } from '../../../../shared/builder/engineLine';
import { formatElapsed } from '../../../../shared/builder/formatElapsed';

/**
 * The build banner on the App Studio canvas — the sibling of the automation
 * builder's BuildBanner (automation/Builder/flow/CanvasSouthBar.jsx).
 *
 * It REPLACES the amber "AI is editing…" pill on a 55 % dimming overlay: that
 * chip hid the very cards the film is about, and it said nothing. This says
 * the four things a person watching wants: that it is live (the dot), how
 * long (the clock), what just happened (the last activity row's exact words)
 * and how far along (the plan strip) — and, on the right, where the model
 * runs and how fast (the engine line, every word a measurement). After the
 * build, a frozen farewell for a few seconds. Nothing amber, nothing dimmed,
 * 12 px, bottom-centre.
 *
 * `--editor-accent` marks the live thing on this canvas (the automation canvas
 * uses `--accent`; here that is grey by product decision).
 */
const FAREWELL_MS = 4000;
const TODO_MAX = 48;
const REASON_MAX = 72;

function elapsedSince(startedAt, now) {
    return startedAt ? formatElapsed(new Date(startedAt).toISOString(), now) : null;
}

function shortReason(reason) {
    const s = String(reason || '').replace(/\s+/g, ' ').trim();
    return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1).trimEnd()}…` : s;
}

/** "Plan 2/5 · Koppel de tabel" — only when the model published a plan. */
export function planStrip(todos, verb) {
    const list = Array.isArray(todos) ? todos : [];
    const total = list.length;
    if (!total) return null;
    const done = list.filter((x) => x && x.done).length;
    const next = list.find((x) => x && !x.done);
    const text = String((next && next.text) || '').replace(/\s+/g, ' ').trim();
    const head = text.length > TODO_MAX ? text.slice(0, TODO_MAX - 1).trimEnd() : text;
    const shown = head && head.length < text.length ? `${head}…` : head;
    const duplicate = !!(head && verb && String(verb).includes(head));
    return { done, total, next: shown && !duplicate ? shown : null };
}

function PlanStrip({ todos, phaseInfo, verb, t }) {
    const plan = planStrip(todos, verb);
    if (plan) {
        return (
            <span className="tabular-nums text-[var(--text-tertiary)]" data-testid="app-build-plan">
                {' · '}{t('app_studio.builder.banner.plan_progress', 'Plan {done}/{total}', { done: plan.done, total: plan.total })}
                {plan.next && <span className="text-[var(--text-secondary)]" data-testid="app-build-plan-next"> · {plan.next}</span>}
            </span>
        );
    }
    if (phaseInfo && Number.isFinite(phaseInfo.index)) {
        return (
            <span className="tabular-nums text-[var(--text-tertiary)]" data-testid="app-build-phase">
                {' · '}{t('app_studio.builder.banner.phase', 'Phase {i}/{n}', { i: phaseInfo.index, n: phaseInfo.total || '?' })}
                {phaseInfo.label && <span className="text-[var(--text-secondary)]"> · {phaseInfo.label}</span>}
            </span>
        );
    }
    return null;
}

function EngineLine({ engine, turn, t }) {
    const pill = enginePill({ engine, t });
    const segments = engineSegments({ engine, turn, t });
    if (!pill && !segments.length) return null;
    const title = [
        engine && engine.modelId ? String(engine.modelId) : null,
        showsRates({ engine, turn }) ? 'measured on the last model call' : null,
    ].filter(Boolean).join(' · ') || undefined;
    return (
        <span className="hidden min-w-0 truncate text-[11px] tabular-nums text-[var(--text-tertiary)] lg:block" title={title} data-testid="app-build-engine" data-local={engine && engine.local === true ? '' : undefined}>
            {pill && (
                <span className="mr-1.5 inline-flex items-center rounded-full border border-[var(--border-default)] px-1.5 py-px align-middle text-[10px] font-medium text-[var(--text-secondary)]" data-testid="app-build-engine-local">{pill}</span>
            )}
            {segments.map((seg, i) => <span key={seg}>{i > 0 ? ' · ' : ''}{seg}</span>)}
        </span>
    );
}

/**
 * Whether to show, and what: the live cue while running, then the frozen
 * farewell for FAREWELL_MS after it ends. Pure over (cue, now).
 */
export function bannerState(cue, prev, now) {
    if (cue && cue.running) return { kind: 'live', cue, endedAt: null, farewell: null };
    if (prev && prev.kind === 'live') {
        // The build just ended: freeze what it was into the farewell.
        return { kind: 'farewell', cue: null, endedAt: now, farewell: { startedAt: prev.cue.startedAt, finalized: !!(cue && cue.finalized), stopped: !!(cue && cue.stopped), componentCount: cue ? cue.componentCount : prev.cue.componentCount, screenCount: cue ? cue.screenCount : prev.cue.screenCount } };
    }
    if (prev && prev.kind === 'farewell' && now - prev.endedAt < FAREWELL_MS) return prev;
    return { kind: 'none', cue: null, endedAt: null, farewell: null };
}

/**
 * @param {{ following?: boolean, onFollow?: Function|null, screen?: {id,name}|null }} props
 *   `screen` — the chapter the camera resolved (useBuildFollow), shown after
 *   the verb as "on Suppliers" so the banner and the canvas agree by
 *   construction; skipped when the verb already names it.
 */
export default function BuildBanner({ following = true, onFollow = null, screen = null }) {
    const { t } = useTranslation();
    const cue = useBuildCue();
    const [now, setNow] = useState(() => Date.now());
    const [state, setState] = useState(() => bannerState(cue, null, Date.now()));
    useEffect(() => { setState((prev) => bannerState(cue, prev, Date.now())); }, [cue]);
    const live = state.kind === 'live';
    useEffect(() => {
        if (state.kind === 'none') return undefined;
        const id = setInterval(() => {
            const at = Date.now();
            setNow(at);
            setState((prev) => bannerState(cue, prev, at));
        }, 1000);
        return () => clearInterval(id);
    }, [state.kind, cue]);
    if (state.kind === 'none') return null;

    const c = state.cue;
    const lastCall = live && c ? c.lastCall : null;
    const elapsed = live ? elapsedSince(c.startedAt, now) : elapsedSince(state.farewell && state.farewell.startedAt, state.endedAt);
    let verb = null;
    let verbTone = null;
    if (live && c.skipped) {
        verb = t('app_studio.builder.banner.build_skipped', 'Skipped: {reason}', { reason: shortReason(c.skipped) });
        verbTone = 'var(--warning)';
    } else if (live && c.phase === 'checking') {
        verb = t('app_studio.builder.banner.checking', 'Checking the app…');
    } else if (live && lastCall && lastCall.title) {
        verb = lastCall.detail ? `${lastCall.title} · ${lastCall.detail}` : lastCall.title;
    }
    const screenName = live && screen && typeof screen.name === 'string' && screen.name.trim() ? screen.name.trim() : '';
    const onScreen = screenName && !(verb && verb.includes(screenName))
        ? t('app_studio.builder.banner.on_screen', 'on {screen}', { screen: screenName })
        : '';
    const accent = 'var(--editor-accent, var(--accent))';
    const dotTone = live ? accent : (state.farewell && state.farewell.finalized ? 'var(--success, #10b981)' : 'var(--text-tertiary)');
    return (
        <div
            className="flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,var(--bg-secondary))] py-2 pl-3.5 pr-2 text-[12px] text-[var(--text-primary)]"
            style={{ boxShadow: 'var(--shadow-popover, 0 4px 16px rgba(0,0,0,.12))' }}
            data-testid="app-build-banner"
            data-phase={live ? c.phase : 'ended'}
        >
            <span className="relative flex h-2 w-2 shrink-0">
                {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" style={{ background: dotTone }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: dotTone, boxShadow: `0 0 0 3px color-mix(in srgb, ${dotTone} 30%, transparent)` }} />
            </span>
            <span className="whitespace-nowrap">
                {live ? (
                    <>
                        <b>{t('app_studio.builder.banner.build_live', 'Building')}</b>
                        {elapsed && <span className="tabular-nums text-[var(--text-tertiary)]" data-testid="app-build-elapsed"> · {elapsed}</span>}
                        {verb && <span className="text-[var(--text-secondary)]" style={verbTone ? { color: verbTone } : undefined} data-testid="app-build-verb"> · {verb}</span>}
                        {onScreen && <span className="text-[var(--text-secondary)]" data-testid="app-build-screen"> · {onScreen}</span>}
                        <PlanStrip todos={c.todos} phaseInfo={c.phaseInfo} verb={verb} t={t} />
                    </>
                ) : (
                    <span data-testid="app-build-farewell">
                        {state.farewell.stopped
                            ? t('app_studio.builder.banner.build_stopped', 'Stopped — draft saved')
                            : state.farewell.finalized
                                ? t('app_studio.builder.banner.build_done', 'Built · {n} components · {s} screens · {t}', { n: state.farewell.componentCount ?? 0, s: state.farewell.screenCount ?? 0, t: elapsed || '0s' })
                                : t('app_studio.builder.banner.build_saved', 'Saved · {n} components', { n: state.farewell.componentCount ?? 0 })}
                    </span>
                )}
            </span>
            {live && <EngineLine engine={c.engine || null} turn={c.turn || null} t={t} />}
            {live && following === false && onFollow && (
                <button
                    type="button"
                    onClick={onFollow}
                    data-testid="app-build-follow"
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-default)] px-2.5 py-1 font-medium text-[var(--text-primary)] transition hover:bg-[var(--bg-tertiary)]"
                >
                    <Crosshair size={12} /> {t('app_studio.builder.banner.follow', 'Follow the build')}
                </button>
            )}
        </div>
    );
}
