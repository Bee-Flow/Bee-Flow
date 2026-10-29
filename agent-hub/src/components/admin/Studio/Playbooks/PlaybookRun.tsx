import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HandoffCard from './HandoffCard';
import { canSkip, isComplete, kindOf, nextActionable, nextPending, type Phase, type PlaybookEvent } from './phaseMachine';
import PhaseInspector from './PhaseInspector';
import { AutopilotCountdown, PhaseRailAside, PlaybookBar, PlaybookLoadFailed, PlaybookLoading } from './PlaybookRunParts';
import { AUTOPILOT_KEY, autopilotLingerSeconds, readAutopilot } from './playbookView';
import './playbooks.css';
import { phaseLabel } from './recipes';
import AccessStage from './stages/AccessStage';
import AppStage from './stages/AppStage';
import ComplianceStage from './stages/ComplianceStage';
import DesignStage from './stages/DesignStage';
import DoneCard from './stages/DoneCard';
import FillStage from './stages/FillStage';
import AutomationStage from './stages/AutomationStage';
import TableStage from './stages/TableStage';
import usePlaybook, { type ServerPlaybook } from './usePlaybook';
import usePresenterFlag from './usePresenterFlag';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import useTranslation from '@/hooks/useTranslation';
import { setItem } from '@/utils/scopedStorage';
import { formatElapsed } from '@/components/shared/builder/formatElapsed';
import useConfirm from '@/components/shared/useConfirm';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppUserLike } from '@/components/projects/workspace/types';
import type { PlaybookOptions, StageProps, PlaybookRunProps } from './PlaybookRun.types';
import { logger } from '@/utils/logger';

/**
 * One open playbook — the film. Left, the PhaseRail; right, the stage of
 * the phase in hand (the builders themselves for automation/app, the server
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
const PINNABLE_TIERS = new Set<string | undefined>(['fast', 'auto', 'standard', 'thinking', 'pro', 'deep_thinking']);
// Phases autopilot never continues on its own: what landed IS the thing to
// read, and `done` is a one-way door (lifecycle.js — nothing leaves `done`).
const AUTOPILOT_NEVER = new Set<string | null>(['access', 'compliance']);

interface AutopilotArgs {
    autopilot: boolean;
    playbook: ServerPlaybook | null;
    active: Phase | null;
    busy: boolean;
    onContinue: (brief: string | undefined) => Promise<ServerPlaybook | null | undefined>;
    phases: Phase[];
}

function useAutopilot({ autopilot, playbook, active, busy, onContinue, phases }: AutopilotArgs) {
    // Autopilot: continue once per (phase, version) — never twice for one
    // landing — but not at once: the landing stays on screen for a moment
    // (the rows that arrived, the wireframes), with a countdown and a
    // "Continue now". The moment is longer when there is something to read.
    const autoRef = useRef<string>(null);
    const [autoCountdown, setAutoCountdown] = useState<number | null>(null);
    // Access and compliance are decisions, not landings: their whole content
    // is what the person is being asked to read. Autopilot never walks past
    // one, and it never closes the film on the closing phase either.
    const autopilotWontAct = !!active && (AUTOPILOT_NEVER.has(kindOf(active)) || !nextPending(phases, active.key));
    useEffect(() => {
        const timers: NodeJS.Timeout[] = [];
        const later = (fn: (() => void) | (() => Promise<void>), ms: number) => { timers.push(setTimeout(fn, ms)); };
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
    const continueNow = useCallback((brief: string | undefined) => {
        if (active && playbook) autoRef.current = `${active.key}:${playbook.version}`;
        setAutoCountdown(null);
        onContinue(brief);
    }, [active, playbook, onContinue]);

    return { autoCountdown, autopilotWontAct, continueNow };
}

export default function PlaybookRun({ playbookId, user = null, onBack, onNavigate = null }: PlaybookRunProps) {
    const { t } = useTranslation();
    const { playbook, loading, error, conflict, dispatch, reload } = usePlaybook(playbookId);
    const { confirm, confirmDialog } = useConfirm();
    const presenter = usePresenterFlag();
    const reducedMotion = useReducedMotion();
    const [autopilot, setAutopilot] = useState(readAutopilot);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    // Click a phase in the rail → its details beside the stage. The stage
    // itself stays MOUNTED underneath (a builder's stream would die with it).
    const [inspectKey, setInspectKey] = useState<string | null>(null);
    // The rail folds to its circles while the rows are arriving — the flow
    // and the table get the width. `null` = follow the film; a press pins it.
    const [railOpen, setRailOpen] = useState<boolean | null>(null);

    const phases = useMemo(() => (playbook && Array.isArray(playbook.phases) ? playbook.phases : []), [playbook]);
    const active = useMemo(() => nextActionable(phases), [phases]);
    // Between the optimistic `done` and the server's answer NO phase is
    // actionable — the consented one is done, the next is still pending — so
    // `active` is null. Rendering that as nothing blanked the stage on every
    // Continue and unmounted the app editor `stageKey` exists to keep mounted.
    // The last phase that WAS actionable stays on screen until the answer lands.
    const lastActiveRef = useRef<Phase>(null);
    useEffect(() => { if (active) lastActiveRef.current = active; }, [active]);
    const onStage = active || lastActiveRef.current;
    const complete = playbook && (playbook.status === 'stopped' || playbook.status === 'done' || isComplete(phases));
    const activeIndex = onStage ? phases.findIndex((p) => p.key === onStage.key) : -1;
    const next = active ? nextPending(phases, active.key) : null;
    // The tier the playbook was started on rides every phase. It used to
    // collapse to `fast` unless it was `auto`, so picking Think or Deep
    // Thinking in the dialog changed nothing about what actually built.
    const forcedTier = PINNABLE_TIERS.has((playbook?.options as PlaybookOptions | undefined)?.tier) ? (playbook?.options as PlaybookOptions | undefined)?.tier : 'fast';

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

    const act = useCallback(async (event: PlaybookEvent, base: ServerPlaybook | null = null) => {
        setBusy(true);
        try { return await dispatch(event, base); } finally { setBusy(false); }
    }, [dispatch]);

    const onContinue = useCallback((brief: string | undefined) => {
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
        const fresh = (pb.phases || []).find((p: Phase) => p.key === next.key);
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

    const { autoCountdown, autopilotWontAct, continueNow } = useAutopilot({ autopilot, playbook, active, busy, onContinue, phases });

    const toggleAutopilot = () => {
        const on = !autopilot;
        setAutopilot(on);
        try { setItem(AUTOPILOT_KEY, on ? '1' : '0'); } catch (err) { logger.debug('storage is a convenience', err); }
    };

    if (loading && !playbook) return <PlaybookLoading t={t} />;
    if (!playbook) return <PlaybookLoadFailed t={t} message={error?.message} onBack={onBack} />;

    const inspected = inspectKey ? phases.find((p) => p.key === inspectKey) || null : null;
    const liveFill = !!active && kindOf(active) === 'fill' && active.status === 'running';
    const railCollapsed = railOpen === null ? liveFill : !railOpen;

    const activeLabel = onStage ? phaseLabel(onStage, t) : null;
    const elapsed = running ? formatElapsed(active.startedAt, now) : null;
    // An error means the person has to act, so the card comes back even with
    // autopilot on — otherwise a refused Continue leaves a screen with no
    // countdown, no card and nothing to press. Same when autopilot REFUSES the
    // phase (access, compliance, the closing one): the countdown never starts,
    // so without the card there was literally nothing to press (2026-09-17).
    const showHandoff = !!active && !complete && (active.status === 'failed' || (active.status === 'awaiting' && (!autopilot || !!error || autopilotWontAct)) || (active.status === 'running' && active.needsInput));
    const stageProps = { playbook, phase: onStage as Phase, dispatch, t, user, onBack, forcedTier, reducedMotion, presenter, onNavigate };

    return (
        <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]" data-testid="playbook-run" data-presenter={presenter ? '1' : undefined}>
            <PlaybookBar
                t={t} title={playbook.title as string} status={playbook.status} complete={!!complete} presenter={presenter} onBack={onBack}
                phaseLine={t('playbooks.bar.phase', 'Phase {n} of {total}: {phase}', { n: activeIndex + 1, total: phases.length, phase: activeLabel || '' })}
                elapsed={elapsed} running={running} autopilot={autopilot} onToggleAutopilot={toggleAutopilot} busy={busy} onStop={onStop}
            />

            {notice && (
                <div role="status" className="text-xs px-4 py-1.5 [background:color-mix(in_srgb,var(--warning)_12%,transparent)] [color:var(--text-primary)]! [border-bottom:1px_solid_var(--border-default)]">{notice}</div>
            )}

            <div className="flex-1 min-h-0 flex">
                <PhaseRailAside t={t} phases={phases} activeKey={active ? active.key : null} presenter={presenter} collapsed={railCollapsed}
                    onToggle={() => setRailOpen(railCollapsed)} selectedKey={inspectKey} onSelect={(key) => setInspectKey((cur) => (cur === key ? null : key))} />
                <main className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                    <div className="flex-1 min-h-0 relative">
                        {complete ? (
                            <DoneCard playbook={playbook as ServerPlaybook & { title: string }} onNavigate={onNavigate} onBack={onBack} onResume={() => act({ type: 'resume' })} busy={busy} t={t} presenter={presenter} />
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
                        {autoCountdown !== null && <AutopilotCountdown t={t} seconds={autoCountdown} onNow={() => continueNow(undefined)} />}
                    </div>
                    {/* Docked UNDER the stage, never over it: the rows the fill phase
                        shows and the wireframes of the design phase stay visible while
                        the person reads the next brief (measured 2026-09-14: the card
                        covered the table it was asking about). */}
                    {showHandoff && (
                        <div className="shrink-0 flex justify-center overflow-y-auto [padding:12px_24px_16px] [border-top:1px_solid_var(--border-default)] [background:var(--bg-primary)] max-h-[48%]">
                            <div className="w-full max-w-[760px]">
                                <HandoffCard
                                    key={`${active.key}:${active.status}:${next ? next.key : ''}`}
                                    phase={active}
                                    next={active.status === 'awaiting' ? next : null}
                                    index={activeIndex}
                                    total={phases.length}
                                    t={t}
                                    presenter={presenter}
                                    busy={busy}
                                    canMarkDone={(kindOf(active) === 'automation' && !!active.artifacts?.automationId) || ((kindOf(active) === 'app' || kindOf(active) === 'app_turn') && !!active.artifacts?.appId)}
                                    onContinue={onContinue}
                                    onSkipNext={onSkipNext}
                                    onRetry={() => act({ type: 'retry', key: active.key })}
                                    onSkip={() => act({ type: 'skip', key: active.key })}
                                    onStop={onStop}
                                    onMarkDone={() => act({ type: 'markDone', key: active.key, artifacts: kindOf(active) === 'automation' ? { automationId: active.artifacts?.automationId } : { appId: active.artifacts?.appId } })}
                                    onDismiss={() => dispatch({ type: 'dismiss_input', key: active.key })}
                                />
                            </div>
                        </div>
                    )}
                </main>
            </div>
            {confirmDialog}
            {error && !notice && (
                <div role="alert" className="text-xs px-4 py-1.5 flex items-center justify-between [background:color-mix(in_srgb,var(--error)_10%,transparent)] [color:var(--text-primary)]! [border-top:1px_solid_var(--border-default)]">
                    <span>{error.message}</span>
                    <button type="button" className="underline" onClick={() => reload()}>{t('playbooks.reload', 'Reload')}</button>
                </div>
            )}
        </div>
    );
}

/** The app stage keeps ONE mount across app → approvals (same appId). */
function stageKey(playbook: ServerPlaybook, phase: Phase) {
    const kind = kindOf(phase);
    if (kind === 'app' || kind === 'app_turn') return `app:${(phase.artifacts && phase.artifacts.appId) || playbook.id}`;
    return phase.key;
}

/** The stage is the phase's KIND — a custom recipe's phases carry any key. */
function Stage(props: StageProps) {
    switch (kindOf(props.phase)) {
        case 'table': return <TableStage {...props} tableMode={(props.playbook?.options as PlaybookOptions | undefined)?.tableMode || 'new'} />;
        case 'automation': return <AutomationStage {...props} />;
        case 'fill': return <FillStage {...props} />;
        case 'design': return <DesignStage {...props} />;
        case 'app':
        case 'app_turn': return <AppStage {...props} />;
        case 'access': return <AccessStage {...props} />;
        case 'compliance': return <ComplianceStage {...props} />;
        default: return null;
    }
}
