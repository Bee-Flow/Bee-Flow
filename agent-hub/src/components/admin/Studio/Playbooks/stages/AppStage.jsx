import React, { useCallback, useEffect, useRef, useState } from 'react';
import StageMessage from './StageMessage';
import BuilderChatPane from '../../AppStudio/chat/BuilderChatPane';
import AppEditorShell from '../../AppStudio/editor/AppEditorShell';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';
import { kindOf } from '../phaseMachine';
import { phaseLabel } from '../recipes';

/**
 * Phases 4 and 5 — the App Studio editor with its builder pane, unchanged.
 * The server pre-created the app (artifacts.appId) when the fill phase was
 * confirmed; this stage loads it, PATCHes `running` before the pane mounts,
 * and hands the brief to the pane as `autoSend` (fires once per mount, the
 * key changes per phase + attempt). The approvals phase REMOUNTS ONLY THE
 * PANE: the shell keeps its definition, the pane rehydrates the server's
 * session for the same app — the second turn rides the windowed history.
 */
export default function AppStage({ playbook, phase, dispatch, onBack, t, forcedTier = 'fast', presenter = false }) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const appId = art.appId || null;
    const attempt = phase?.attempt || 0;
    const [app, setApp] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const startedRef = useRef(null);

    useEffect(() => {
        if (!appId) return undefined;
        if (app && app.id === appId) return undefined;
        let alive = true;
        studioAppsApi.getApp(appId).then((r) => {
            if (!alive) return;
            if (r && r.app && r.app.id) { setApp(r.app); setLoadError(null); } else setLoadError(new Error('App not found'));
        }).catch((e) => { if (alive) setLoadError(e); });
        return () => { alive = false; };
    }, [appId, app]);

    useEffect(() => {
        if (status !== 'ready' || !appId) return;
        const stamp = `${phase.key}:${attempt}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, attempt, appId, dispatch]);

    // A missing app or an app that will not open is a FAILED phase, not a
    // sentence on a screen with no buttons.
    const deadRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready' && status !== 'running') return;
        const why = !appId ? 'artifacts_missing' : (loadError ? 'app_unreadable' : null);
        if (!why || deadRef.current === `${phase.key}:${attempt}:${why}`) return;
        deadRef.current = `${phase.key}:${attempt}:${why}`;
        dispatch({ type: 'failed', key: phase.key, error: why });
    }, [status, appId, loadError, phase.key, attempt, dispatch]);

    const stampedRef = useRef(null);
    useEffect(() => {
        if (status !== 'running' || phase._optimistic || !app) return;
        const stamp = `${phase.key}:${attempt}`;
        if (stampedRef.current === stamp) return;
        stampedRef.current = stamp;
        const sentBefore = Number.isInteger(art.briefSentAttempt);
        if (sentBefore) {
            // Mounted on a pane that will not fire the brief (reload, retry):
            // the person drives the chat, so offer "Mark as done" now.
            dispatch({ type: 'needs_input', key: phase.key });
            return;
        }
        dispatch({ type: 'artifact', key: phase.key, artifacts: { briefSentAttempt: attempt, briefSentAt: new Date().toISOString() } });
    }, [status, phase._optimistic, art.briefSentAttempt, app, phase.key, attempt, dispatch]);

    // The name the builder gives the app (app_set_meta, or the finalize-time
    // net) reaches the shell header and the phase summary at once.
    const onAppUpdated = useCallback((next) => setApp((prev) => (prev && next && prev.id === next.id ? { ...prev, ...next } : prev)), []);

    const onTurnEnd = useCallback(({ finalized, stopped, error, code }) => {
        if (finalized) {
            // An app_turn is "a further turn of the app builder on the same
            // app" and composeRecipe FORBIDS it from being an approval flow —
            // yet every one of them landed saying "Approval flow added". Name
            // the turn instead, the way the routine stage names its routine.
            const summary = kindOf(phase) === 'app_turn'
                ? t('playbooks.app.summary_turn', '{phase} landed on "{name}".', { phase: phaseLabel(phase, t), name: (app && app.name) || playbook.title || '' })
                : t('playbooks.app.summary_app', 'App "{name}" built.', { name: (app && app.name) || playbook.title || '' });
            dispatch({ type: 'finished', key: phase.key, summary, artifacts: { appId, ...(app && app.name ? { appName: app.name } : {}) } });
            return;
        }
        if (error || stopped) {
            dispatch({ type: 'failed', key: phase.key, error: code || (error ? String(error.message || error) : 'stopped') });
            return;
        }
        dispatch({ type: 'needs_input', key: phase.key });
    }, [dispatch, phase, app, appId, playbook.title, t]);

    // A phase with nothing to build on, or an app that will not open, used to
    // print a sentence and stop: the phase stayed `ready`, so the handoff card
    // rendered nothing and there was no Retry, no Skip, nothing to press. It
    // fails instead, and the failed face takes over.
    if (!appId || loadError) {
        return (
            <StageMessage
                tone={loadError ? 'error' : 'warn'}
                presenter={presenter}
                testId={loadError ? 'playbook-stage-app-error' : 'playbook-stage-app-missing'}
            >
                {loadError
                    ? (loadError.message || t('playbooks.app.load_failed', 'Could not open the app.'))
                    : t('playbooks.app.no_app', 'No app was prepared for this phase — retry the previous step.')}
            </StageMessage>
        );
    }
    if (!app) {
        return (
            <StageMessage tone="busy" presenter={presenter} testId="playbook-stage-app-loading">
                {t('playbooks.app.opening', 'Opening the app…')}
            </StageMessage>
        );
    }

    // The pane mounts only once the phase is running, so `autoSend` is set
    // at its FIRST effect pass — before the session rehydrate lands. (The
    // approvals turn reopens an app whose session already has messages;
    // a pane mounted early would see them first and never fire the brief.)
    const paneKey = `${playbook.id}:${phase.key}:${attempt}`;
    const live = (status === 'running' && !phase._optimistic) || status === 'awaiting' || status === 'failed';
    // A reload mid-turn must not send the brief twice: the first mount stamps
    // `briefSentAttempt` on the phase; later mounts of the same attempt send nothing
    // (a retry is a new attempt and fires again).
    // A retry after a sent brief (a stop mid-turn, a model that gave up)
    // does NOT auto-fire on an app that is already half there: the brief is
    // prefilled, the person sends it — or marks the phase done as it is.
    const sentBefore = Number.isInteger(art.briefSentAttempt);
    const prefill = status === 'running' && sentBefore && art.briefSentAttempt < attempt;
    // A SECOND turn on an app that is already built gets the same system prompt
    // as a first build — which opens "FIRST MOVE on any NEW app: pick an
    // identity with ONE app_set_theme call". The model duly re-themes and
    // re-adds screens nobody asked for. One line of framing in front of the
    // brief is the cheapest place to say otherwise, and it rides the per-turn
    // message rather than the cached prompt prefix.
    const brief = kindOf(phase) === 'app_turn' && phase.brief
        ? `${t('playbooks.app.turn_framing', 'This app is already built and finalised. Make ONLY the change below. Do not call app_set_theme, app_upsert_table or app_seed_records, and do not rebuild screens that already exist.')}\n\n${phase.brief}`
        : (phase.brief || null);
    const autoSend = status === 'running' && !prefill && art.briefSentAttempt !== attempt ? brief : null;
    return (
        <div className="h-full pbk-stage-enter" data-testid="playbook-stage-app" data-phase={phase.key} data-kind={kindOf(phase)}>
            <AppEditorShell
                key={appId}
                app={app}
                onClose={onBack}
                onAppUpdated={(next) => setApp((prev) => (prev && next && prev.id === next.id ? { ...prev, ...next } : prev))}
                // Never null: a falsy slot makes the editor render its own
                // "AI assistant — coming soon" rail, which is what the room saw
                // for the whole `ready` beat of the app phase.
                chatSlot={live
                    ? <BuilderChatPane key={paneKey} appId={appId} autoSend={autoSend} initialPrompt={prefill ? (brief || '') : ''} forcedTier={forcedTier} onTurnEnd={onTurnEnd} onAppUpdated={onAppUpdated} />
                    : <StageMessage tone="busy" presenter={presenter} testId="playbook-stage-app-handing">{t('playbooks.app.handing', 'Handing the brief to the app builder…')}</StageMessage>}
            />
        </div>
    );
}
