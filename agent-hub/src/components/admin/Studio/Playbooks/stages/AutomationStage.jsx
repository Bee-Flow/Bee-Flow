import React, { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import StageMessage from './StageMessage';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import BuilderShell from '../../../../automation/Builder/BuilderShell';

/**
 * Phase 2 — the automation builder, unchanged, mounted as the stage. The page
 * PATCHes `running` BEFORE the shell mounts (so a reload during the build
 * lands on a running phase, not a ready one that fires the brief twice),
 * hands the brief as `autoSendInput`, pins the tier, and hears the end of
 * every turn through `onTurnEnd`:
 *   finalized → awaiting (+ title / step count for the rail),
 *   aborted or error → failed,
 *   otherwise (the builder asked something) → needs_input, the handoff card
 *   offers "Mark as done" once an automation exists.
 * A retry with an existing automation prefills the chat instead of auto-firing
 * (the shell's canAutoSend wants a fresh automation) — copy says so.
 */
/**
 * The name of the first non-note step the trigger cannot reach, or null.
 *
 * `runDag` walks from the trigger only, so an unwired step is never dispatched
 * — and nothing else in the stack says so: the regression lock in validate.test
 * pins that a disconnected step is `ok: true` with no warning at all.
 */
export function unreachableStep(def) {
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const edges = Array.isArray(def?.edges) ? def.edges : [];
    const start = def?.trigger?.id || def?.rootStepId;
    if (!steps.length || !start) return null;
    const next = new Map();
    for (const e of edges) {
        const from = e && (e.from ?? e.source ?? e.fromStepId);
        const to = e && (e.to ?? e.target ?? e.toStepId);
        if (from == null || to == null) continue;
        if (!next.has(from)) next.set(from, []);
        next.get(from).push(to);
    }
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        for (const to of next.get(queue.shift()) || []) {
            if (seen.has(to)) continue;
            seen.add(to);
            queue.push(to);
        }
    }
    // Only meaningful when the definition really uses an edge list; a shape we
    // do not recognise must never fail a build that is fine.
    if (!edges.length) return null;
    const lost = steps.find((st) => st && st.id && st.type !== 'note' && !seen.has(st.id));
    return lost ? (lost.label || lost.name || lost.type || lost.id) : null;
}

/**
 * The title a brief STATES — `Title "…"` / `Titel "…"` / `Naam "…"` /
 * `Name "…"`, straight, curly or single quotes, in statement position (a
 * mid-sentence `the sender name "From"` is a field, not a title). The SAME
 * pattern as server/automation/builderTools/deriveTitle.js TITLE_IN_BRIEF_RE
 * — deriveTitle.test.js pins the two sources equal — so the name this stage
 * seeds is the one the server would derive anyway; seeding it means the
 * automation is named from its first persisted byte instead of at the end of
 * the build. Null when the brief states none.
 */
export const TITLE_IN_BRIEF_RE = /(?:\b(?:app\s+)?(?:title|titel)|(?:^|\n|[.!?;]\s+)\s*(?:[-*•]\s+)?(?:app\s+)?(?:naam|name)|\b(?:app\s+)?(?:naam|name)(?=\s*[:=]))\s*[:=]?\s*["“„'‘]((?:[^"”“'’\n]|['’](?=\w)){3,120})["”“'’](?!\w)/i;
export function titleFromBrief(brief) {
    const m = typeof brief === 'string' ? TITLE_IN_BRIEF_RE.exec(brief) : null;
    return m ? m[1].trim().slice(0, 60) : null;
}

export default function AutomationStage({ playbook, phase, dispatch, user, t, forcedTier = 'fast', presenter = false }) {
    const api = useAutomationApi();
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const attempt = phase?.attempt || 0;
    // The shell mounts once the phase is running (the start PATCH answered).
    const mounted = (status === 'running' && !phase._optimistic) || status === 'awaiting' || status === 'failed';
    const startedRef = useRef(null);

    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${attempt}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, attempt, dispatch]);

    // Mounted on an EXISTING automation (reload mid-build, retry): the shell
    // will not fire the brief, the person drives the chat — offer "Mark as
    // done" at once.
    // (Not on the first build: there the id arrives mid-turn, through
    // onAutomationIdResolved, while the shell is still typing.)
    const askedRef = useRef(null);
    const offerMarkDone = useEffectEvent(() => {
        if (!art.automationId || phase.needsInput) return;
        dispatch({ type: 'needs_input', key: phase.key });
    });
    useEffect(() => {
        if (!mounted || status !== 'running') return;
        const stamp = `${attempt}`;
        if (askedRef.current === stamp) return;
        askedRef.current = stamp;
        offerMarkDone();
    }, [mounted, status, attempt]);

    const onAutomationIdResolved = useCallback((id) => {
        if (!id || id === art.automationId) return;
        dispatch({ type: 'artifact', key: phase.key, artifacts: { automationId: id } });
    }, [dispatch, art.automationId, phase.key]);

    const onTurnEnd = useCallback(async ({ finalized, aborted, error, automationId }) => {
        const id = automationId || art.automationId || null;
        if (finalized && id) {
            let summary = null;
            let title = null;
            try {
                const r = await api.getAutomation(id);
                const a = (r && r.automation) || r;
                // A step wired to nothing is VALID — validate passes it, the
                // dry run reports the steps it did reach, and the run never
                // dispatches it. So the automation lands "ready" and the fill
                // phase adds zero rows. The automation is already in hand here.
                const orphan = unreachableStep(a?.definition);
                if (orphan) {
                    dispatch({ type: 'failed', key: phase.key, error: t('playbooks.automation.unwired', 'The step "{step}" is not connected to the flow, so it would never run. Wire it up and finish again.', { step: orphan }) });
                    return;
                }
                title = a?.title || null;
                const steps = Array.isArray(a?.definition?.steps) ? a.definition.steps.length : (Array.isArray(a?.steps) ? a.steps.length : null);
                summary = t('playbooks.automation.summary', 'Automation "{title}" ready{steps}', { title: title || '', steps: Number.isFinite(steps) ? ` · ${t('playbooks.automation.steps', '{n} steps', { n: steps })}` : '' });
            } catch { /* the rail then shows the id-less fact */ }
            dispatch({ type: 'finished', key: phase.key, summary: summary || undefined, artifacts: { automationId: id, ...(title ? { automationTitle: title } : {}) } });
            return;
        }
        if (aborted || error) {
            dispatch({ type: 'failed', key: phase.key, error: error ? String(error.code || error.message || error) : 'aborted' });
            return;
        }
        dispatch({ type: 'needs_input', key: phase.key });
    }, [dispatch, api, art.automationId, phase.key, t]);

    if (!mounted) {
        return (
            <StageMessage tone="busy" presenter={presenter} testId="playbook-stage-automation-pending">
                {t('playbooks.automation.starting', 'Handing the brief to the automation builder…')}
            </StageMessage>
        );
    }

    const fresh = !art.automationId;
    // The brief's own title, handed to the builder for the draft its first
    // send creates. Nothing to seed when the brief states none — the server
    // then derives one itself at finalize.
    const seedTitle = titleFromBrief(phase.brief);
    return (
        <div className="h-full pbk-stage-enter" data-testid="playbook-stage-automation" data-phase={phase.key}>
            <BuilderShell
                key={`${playbook.id}:automation:${attempt}`}
                automationId={art.automationId || null}
                user={user}
                // The run page already has a back arrow, and it goes somewhere
                // else: two arrows side by side, one of them mislabelled.
                onBack={null}
                onOpenList={null}
                // The brief is auto-sent into this pane. It defaults to CLOSED
                // (a per-user preference), so on a fresh profile the room
                // watched a static canvas while the AI worked out of sight.
                forceAssistantOpen
                autoSendInput={fresh && status === 'running' ? (phase.brief || null) : null}
                initialChatInput={!fresh && attempt > 0 && status === 'running' ? (phase.brief || '') : ''}
                forcedTier={forcedTier}
                seedMetadata={seedTitle ? { title: seedTitle } : null}
                onAutomationIdResolved={onAutomationIdResolved}
                onTurnEnd={onTurnEnd}
            />
        </div>
    );
}
