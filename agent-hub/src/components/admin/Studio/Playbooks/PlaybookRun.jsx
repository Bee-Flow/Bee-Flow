import { AlertTriangle, ArrowLeft, Clapperboard, Loader2, PanelLeftClose, PanelLeftOpen, Presentation, Square, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HandoffCard from './HandoffCard';
import { canSkip, isComplete, kindOf, nextActionable, nextPending } from './phaseMachine';
import PhaseInspector from './PhaseInspector';
import PhaseRail from './PhaseRail';
import { AUTOPILOT_KEY, autopilotLingerSeconds, readAutopilot } from './playbookView';
import './playbooks.css';
import { phaseLabel } from './recipes';
import AccessStage from './stages/AccessStage';
import AppStage from './stages/AppStage';
import ComplianceStage from './stages/ComplianceStage';
import DesignStage from './stages/DesignStage';
import DoneCard from './stages/DoneCard';
import FillStage from './stages/FillStage';
import RoutineStage from './stages/RoutineStage';
import TableStage from './stages/TableStage';
import usePlaybook from './usePlaybook';
import usePresenterFlag from './usePresenterFlag';
import { useReducedMotion } from '../../../../hooks/useReducedMotion';
import useTranslation from '../../../../hooks/useTranslation';
import { setItem } from '../../../../utils/scopedStorage';
import { formatElapsed } from '../../../shared/builder/formatElapsed';
import { kindTileStyle } from '../../../shared/kindColors';
import useConfirm from '../../../shared/useConfirm';

/**
 * One open playbook — the film. Left, the PhaseRail; right, the stage of
 * the phase in hand (the builders themselves for routine/app, the server
 * phases as their own tableaux); over the stage's lower third, the
 * HandoffCard whenever the AI has stopped for the person. The bar on top
 * says where we are, how long this phase has run, and holds Autopilot
 * (continue without asking — a per-user preference) and Stop.
 *
 * Every press goes through usePlaybook.dispatch → phaseMachine.patchFor →
 * one CAS write; the server decides.
 */
// What a playbook may pin a phase to — the depth axis of licensing/tierMeta
// (`pro` and `deep_thinking` are the same tier) plus `standard`. Mirrors the
// server's own list in routes/playbooks.js.
const PINNABLE_TIERS = new Set(['fast', 'auto', 'standard', 'thinking', 'pro', 'deep_thinking']);
// Phases autopilot never continues on its own: what landed IS the thing to
// read, and `done` is a one-way door (lifecycle.js — nothing leaves `done`).
const AUTOPILOT_NEVER = new Set(['access', 'compliance']);

export default function PlaybookRun({ playbookId, user = null, onBack, onNavigate = null }) {
    const { t } = useTranslation();
    const { playbook, loading, error, conflict, dispatch, reload } = usePlaybook(playbookId);
    const { confirm, confirmDialog } = useConfirm();
    const presenter = usePresenterFlag();
    const reducedMotion = useReducedMotion();
    const [autopilot, setAutopilot] = useState(readAutopilot);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    // Click a phase in the rail → its details beside the stage. The stage
    // itself stays MOUNTED underneath (a builder's stream would die with it).
    const [inspectKey, setInspectKey] = useState(null);
    // The rail folds to its circles while the rows are arriving — the flow
    // and the table get the width. `null` = follow the film; a press pins it.
    const [railOpen, setRailOpen] = useState(null);

    const phases = useMemo(() => (playbook && Array.isArray(playbook.phases) ? playbook.phases : []), [playbook]);
    const active = useMemo(() => nextActionable(phases), [phases]);
    // Between the optimistic `done` and the server's answer NO phase is
    // actionable — the consented one is done, the next is still pending — so
    // `active` is null. Rendering that as nothing blanked the stage on every
    // Continue and unmounted the app editor `stageKey` exists to keep mounted.
    // The last phase that WAS actionable stays on screen until the answer lands.
    const lastActiveRef = useRef(null);
    useEffect(() => { if (active) lastActiveRef.current = active; }, [active]);
    const onStage = active || lastActiveRef.current;
    const complete = playbook && (playbook.status === 'stopped' || playbook.status === 'done' || isComplete(phases));
    const activeIndex = onStage ? phases.findIndex((p) => p.key === onStage.key) : -1;
    const next = active ? nextPending(phases, active.key) : null;
    // The tier the playbook was started on rides every phase. It used to
    // collapse to `fast` unless it was `auto`, so picking Think or Deep
    // Thinking in the dialog changed nothing about what actually built.
    const forcedTier = PINNABLE_TIERS.has(playbook?.options?.tier) ? playbook.options.tier : 'fast';

    // The bar's clock: ticks while a phase runs.
    const [now, setNow] = useState(() => Date.now());
    const running = !!active && active.status === 'running';
    useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running]);

    // A stale write elsewhere: the entity was reloaded; say so once.
    const lastConflict = useRef(0);
    useEffect(() => {
        if (conflict && conflict !== lastConflict.current) {
            lastConflict.current = conflict;
            setNotice(t('playbooks.err_conflict', 'This playbook changed elsewhere — showing the latest state.'));
            const id = setTimeout(() => setNotice(null), 5000);
            return () => clearTimeout(id);
        }
        return undefined;
    }, [conflict, t]);

    const act = useCallback(async (event, base = null) => {
        setBusy(true);
        try { return await dispatch(event, base); } finally { setBusy(false); }
    }, [dispatch]);

    const onContinue = useCallback((brief) => {
        if (!active) return Promise.resolve(null);
        // Returns the server's playbook (null when it refused) — autopilot needs
        // to know, so a refused Continue does not stamp itself as done.
        return act({ type: 'continue', key: active.key, nextKey: next ? next.key : null, brief: next && typeof brief === 'string' && brief !== next.brief ? brief : undefined });
    }, [act, active, next]);

    // Skip the NEXT phase: confirm this one, then skip the one that became ready.
    const onSkipNext = useCallback(async () => {
        if (!active || !next) return;
        const pb = await act({ type: 'continue', key: active.key, nextKey: null });
        if (!pb || pb.status !== 'active') return;
        const fresh = (pb.phases || []).find((p) => p.key === next.key);
        if (fresh && canSkip(fresh)) await act({ type: 'skip', key: next.key }, pb);
    }, [act, active, next]);

    const onStop = useCallback(async () => {
        if (!playbook) return;
        const ok = await confirm({
            title: t('playbooks.stop.title', 'Stop this playbook?'),
            description: t('playbooks.stop.note', 'What has landed stays — the table, the automation draft, the app. A builder turn still running finishes on its own.'),
            confirmLabel: t('playbooks.stop.confirm', 'Stop'),
            destructive: true,
        });
        if (!ok) return;
        await act({ type: 'stop' });
    }, [playbook, confirm, act, t]);

    // Autopilot: continue once per (phase, version) — never twice for one
    // landing — but not at once: the landing stays on screen for a moment
    // (the rows that arrived, the wireframes), with a countdown and a
    // "Continue now". The moment is longer when there is something to read.
    const autoRef = useRef(null);
    const [autoCountdown, setAutoCountdown] = useState(null);
    // Access and compliance are decisions, not landings: their whole content
    // is what the person is being asked to read. Autopilot never walks past
    // one, and it never closes the film on the closing phase either.
    const autopilotWontAct = !!active && (AUTOPILOT_NEVER.has(kindOf(active)) || !nextPending(phases, active.key));
    useEffect(() => {
        const timers = [];
        const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
        if (!autopilot || !playbook || !active || active.status !== 'awaiting' || busy || autopilotWontAct) {
            later(() => setAutoCountdown(null), 0);
            return () => timers.forEach(clearTimeout);
        }
        const stamp = `${active.key}:${playbook.version}`;
        if (autoRef.current === stamp) return () => timers.forEach(clearTimeout);
        const secs = autopilotLingerSeconds(active);
        for (let left = secs; left >= 1; left--) later(() => setAutoCountdown(left), (secs - left) * 1000);
        later(async () => {
            if (autoRef.current === stamp) return;
            autoRef.current = stamp;
            setAutoCountdown(null);
            // A refused Continue does not bump the version, so a stamp written
            // BEFORE the call meant this effect returned early for ever after:
            // no countdown, no card, nothing to press. Release the stamp when
            // the server did not accept it, and the manual card comes back.
            const ok = await onContinue(undefined);
            if (!ok && autoRef.current === stamp) autoRef.current = null;
        }, secs * 1000);
        return () => timers.forEach(clearTimeout);
    }, [autopilot, playbook, active, busy, onContinue, phases]);
    // "Continue now" (or a manual Continue) during the countdown: stamp it, so the timer never fires a second Continue.
    const continueNow = useCallback((brief) => {
        if (active && playbook) autoRef.current = `${active.key}:${playbook.version}`;
        setAutoCountdown(null);
        onContinue(brief);
    }, [active, playbook, onContinue]);

    const toggleAutopilot = () => {
        const on = !autopilot;
        setAutopilot(on);
        try { setItem(AUTOPILOT_KEY, on ? '1' : '0'); } catch { /* storage is a convenience */ }
    };

    if (loading && !playbook) {
        return (
            <div className="h-full flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.loading', 'Loading…')}
            </div>
        );
    }
    if (!playbook) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <span className="inline-flex items-center gap-2" style={{ color: 'var(--warning)' }}><AlertTriangle className="w-4 h-4" aria-hidden="true" />{error?.message || t('playbooks.err_load', 'Could not load this playbook')}</span>
                <button type="button" onClick={onBack} className="text-xs underline">{t('playbooks.done.back', 'Back to playbooks')}</button>
            </div>
        );
    }

    const inspected = inspectKey ? phases.find((p) => p.key === inspectKey) || null : null;
    const liveFill = !!active && kindOf(active) === 'fill' && active.status === 'running';
    const railCollapsed = railOpen === null ? liveFill : !railOpen;

    const { tile, glyph } = kindTileStyle('playbook', { size: 32, pct: 16 });
    const activeLabel = onStage ? phaseLabel(onStage, t) : null;
    const elapsed = running ? formatElapsed(active.startedAt, now) : null;
    // An error means the person has to act, so the card comes back even with
    // autopilot on — otherwise a refused Continue leaves a screen with no
    // countdown, no card and nothing to press. Same when autopilot REFUSES the
    // phase (access, compliance, the closing one): the countdown never starts,
    // so without the card there was literally nothing to press (2026-09-17).
    const showHandoff = !!active && !complete && (active.status === 'failed' || (active.status === 'awaiting' && (!autopilot || !!error || autopilotWontAct)) || (active.status === 'running' && active.needsInput));
    const stageProps = { playbook, phase: onStage, dispatch, t, user, onBack, forcedTier, reducedMotion, presenter, onNavigate };

    return (
        <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)' }} data-testid="playbook-run" data-presenter={presenter ? '1' : undefined}>
            <header className="flex items-center gap-3 px-4 shrink-0" style={{ height: 52, borderBottom: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-medium h-8 px-2 rounded-lg" style={{ color: 'var(--text-secondary)' }} aria-label={t('playbooks.bar.back', 'Back to playbooks')}>
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <span style={tile}><Clapperboard style={glyph} aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold" style={{ fontSize: presenter ? 18 : 14, color: 'var(--text-primary)' }}>{playbook.title}</div>
                    <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {complete
                            ? <span>{playbook.status === 'stopped' ? t('playbooks.status.stopped', 'Stopped') : t('playbooks.state.done', 'Done')}</span>
                            : (
                                <>
                                    <span data-testid="playbook-bar-phase">{t('playbooks.bar.phase', 'Phase {n} of {total}: {phase}', { n: activeIndex + 1, total: phases.length, phase: activeLabel || '' })}</span>
                                    {elapsed && (<><span aria-hidden="true">·</span><span className="tabular-nums">{elapsed}</span></>)}
                                    {running && !autopilot && (<><span aria-hidden="true">·</span><span>{t('playbooks.bar.pauses', 'Pauses after this phase')}</span></>)}
                                </>
                            )}
                    </div>
                </div>
                {presenter && (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--type-ai) 12%, transparent)', color: 'var(--type-ai)' }}>
                        <Presentation className="w-3 h-3" aria-hidden="true" />{t('playbooks.bar.presenter', 'Presenter')}
                    </span>
                )}
                {!complete && (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={autopilot}
                        onClick={toggleAutopilot}
                        data-testid="playbook-autopilot"
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] text-xs font-medium"
                        style={{ color: autopilot ? 'var(--type-ai)' : 'var(--text-secondary)', border: `1px solid ${autopilot ? 'var(--type-ai)' : 'var(--border-default)'}`, background: autopilot ? 'color-mix(in srgb, var(--type-ai) 10%, transparent)' : 'transparent' }}
                    >
                        <Zap className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.bar.autopilot', 'Autopilot')}
                    </button>
                )}
                {!complete && (
                    <button type="button" onClick={onStop} disabled={busy} data-testid="playbook-bar-stop" className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] text-xs font-medium disabled:opacity-50" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                        <Square className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.bar.stop', 'Stop')}
                    </button>
                )}
            </header>

            {notice && (
                <div role="status" className="text-xs px-4 py-1.5" style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-default)' }}>{notice}</div>
            )}

            <div className="flex-1 min-h-0 flex">
                <aside className="shrink-0 overflow-y-auto" style={{ width: railCollapsed ? 56 : (presenter ? 280 : 236), padding: railCollapsed ? '16px 0' : (presenter ? '24px 20px' : '20px 16px'), borderRight: '1px solid var(--border-default)', background: 'var(--bg-card)' }} data-testid="playbook-rail-aside" data-collapsed={railCollapsed ? '1' : undefined}>
                    <div className={railCollapsed ? 'flex justify-center mb-3' : 'flex justify-end mb-2'}>
                        <button
                            type="button"
                            onClick={() => setRailOpen(railCollapsed)}
                            className="inline-flex items-center justify-center rounded-lg"
                            style={{ width: 24, height: 24, color: 'var(--text-tertiary)' }}
                            aria-label={railCollapsed ? t('playbooks.rail.expand', 'Show the phases') : t('playbooks.rail.collapse', 'Hide the phases')}
                            data-testid="playbook-rail-toggle"
                        >
                            {railCollapsed ? <PanelLeftOpen className="w-4 h-4" aria-hidden="true" /> : <PanelLeftClose className="w-4 h-4" aria-hidden="true" />}
                        </button>
                    </div>
                    <PhaseRail
                        phases={phases}
                        activeKey={active ? active.key : null}
                        t={t}
                        presenter={presenter}
                        collapsed={railCollapsed}
                        selectedKey={inspectKey}
                        onSelect={(key) => setInspectKey((cur) => (cur === key ? null : key))}
                    />
                </aside>
                <main className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                    <div className="flex-1 min-h-0 relative">
                        {complete ? (
                            <DoneCard playbook={playbook} onNavigate={onNavigate} onBack={onBack} onResume={() => act({ type: 'resume' })} busy={busy} t={t} presenter={presenter} />
                        ) : onStage ? (
                            <Stage key={stageKey(playbook, onStage)} {...stageProps} />
                        ) : null}
                        {inspected && (
                            <PhaseInspector
                                phase={inspected}
                                t={t}
                                presenter={presenter}
                                busy={busy}
                                onNavigate={onNavigate}
                                onRetry={() => act({ type: 'retry', key: inspected.key })}
                                onSkip={() => act({ type: 'skip', key: inspected.key })}
                                onClose={() => setInspectKey(null)}
                            />
                        )}
                        {autoCountdown !== null && (
                            <div className="absolute right-4 bottom-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs" style={{ background: 'var(--bg-card)', border: '1px solid var(--type-ai)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)' }} role="status" data-testid="playbook-autopilot-countdown">
                                <Zap className="w-3.5 h-3.5" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                                {t('playbooks.bar.autopilot_in', 'Autopilot continues in {n} s', { n: autoCountdown })}
                                <button type="button" onClick={() => continueNow(undefined)} className="font-semibold" style={{ color: 'var(--type-ai)' }} data-testid="playbook-autopilot-now">{t('playbooks.bar.autopilot_now', 'Continue now')}</button>
                            </div>
                        )}
                    </div>
                    {/* Docked UNDER the stage, never over it: the rows the fill phase
                        shows and the wireframes of the design phase stay visible while
                        the person reads the next brief (measured 2026-09-14: the card
                        covered the table it was asking about). */}
                    {showHandoff && (
                        <div className="shrink-0 flex justify-center overflow-y-auto" style={{ padding: '12px 24px 16px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-primary)', maxHeight: '48%' }}>
                            <div className="w-full" style={{ maxWidth: 760 }}>
                                <HandoffCard
                                    key={`${active.key}:${active.status}:${next ? next.key : ''}`}
                                    phase={active}
                                    next={active.status === 'awaiting' ? next : null}
                                    index={activeIndex}
                                    total={phases.length}
                                    t={t}
                                    presenter={presenter}
                                    busy={busy}
                                    canMarkDone={(kindOf(active) === 'routine' && !!active.artifacts?.automationId) || ((kindOf(active) === 'app' || kindOf(active) === 'app_turn') && !!active.artifacts?.appId)}
                                    onContinue={onContinue}
                                    onSkipNext={onSkipNext}
                                    onRetry={() => act({ type: 'retry', key: active.key })}
                                    onSkip={() => act({ type: 'skip', key: active.key })}
                                    onStop={onStop}
                                    onMarkDone={() => act({ type: 'markDone', key: active.key, artifacts: kindOf(active) === 'routine' ? { automationId: active.artifacts?.automationId } : { appId: active.artifacts?.appId } })}
                                    onDismiss={() => dispatch({ type: 'dismiss_input', key: active.key })}
                                />
                            </div>
                        </div>
                    )}
                </main>
            </div>
            {confirmDialog}
            {error && !notice && (
                <div role="alert" className="text-xs px-4 py-1.5 flex items-center justify-between" style={{ background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--text-primary)', borderTop: '1px solid var(--border-default)' }}>
                    <span>{error.message}</span>
                    <button type="button" className="underline" onClick={reload}>{t('playbooks.reload', 'Reload')}</button>
                </div>
            )}
        </div>
    );
}

/** The app stage keeps ONE mount across app → approvals (same appId). */
function stageKey(playbook, phase) {
    const kind = kindOf(phase);
    if (kind === 'app' || kind === 'app_turn') return `app:${(phase.artifacts && phase.artifacts.appId) || playbook.id}`;
    return phase.key;
}

/** The stage is the phase's KIND — a custom recipe's phases carry any key. */
function Stage(props) {
    switch (kindOf(props.phase)) {
        case 'table': return <TableStage {...props} tableMode={props.playbook?.options?.tableMode || 'new'} />;
        case 'routine': return <RoutineStage {...props} />;
        case 'fill': return <FillStage {...props} />;
        case 'design': return <DesignStage {...props} />;
        case 'app':
        case 'app_turn': return <AppStage {...props} />;
        case 'access': return <AccessStage {...props} />;
        case 'compliance': return <ComplianceStage {...props} />;
        default: return null;
    }
}
