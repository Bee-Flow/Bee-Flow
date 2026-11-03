import { useCallback, useEffect, useReducer, useRef } from 'react';
import apiClient from '@/api/client';
import { useTranslation } from '@/hooks/useTranslation';
import { continueRunForm, decideRunApproval, discardRun, uploadFormTestFile, type UploadedFile } from './formRunApi';
import { useFormRunFollower, type FollowTiming, type FollowView } from './formRunFollower';
import { initialOverlayState, isParked, overlayReducer, stillGoing, type OverlayState } from './formRunState';
import type { FormDef, FormFieldDef, PublicFormRendererProps } from '../../forms/PublicFormRenderer.types';
import type { FormRunClose, FormRunFollow, FormRunKind, FormRunMode, FormRunStart } from './formRunContract';

/**
 * What the form test overlay DOES (FormRunOverlay draws it): start or continue
 * the journey, decide its approval, follow it, and close without losing
 * anything by accident. The state machine is formRunState.ts, the follow loop
 * formRunFollower.ts, the calls formRunApi.ts.
 */
export interface FormRunJourneyOptions {
    automationId: string | null | undefined;
    form?: FormDef;
    attachRunId: string | null;
    onStartRun: FormRunStart;
    startMode: FormRunMode;
    onFollowRun?: FormRunFollow;
    onClose: FormRunClose;
    runKind: FormRunKind | null;
    triggerStepId: string | null;
    followTiming?: FollowTiming;
}

type SearchResult = Awaited<ReturnType<NonNullable<PublicFormRendererProps['onSearchApp']>>>;

/** Search the app picker against the owner's own connections. */
async function searchApp(automationId: string | null | undefined, field: FormFieldDef, query: string): Promise<SearchResult> {
    const body = await apiClient.post<SearchResult>(`/api/automation/${encodeURIComponent(String(automationId))}/form-pick`, { source: field.source, query });
    return body || { results: [] };
}

/** The shell is told which runs were still going, so it does not open the overlay again for them (RUN-11). */
const closeInfo = (s: OverlayState) => (stillGoing(s) ? { dismissRunIds: s.runIds } : {});

/** What a close asks first: nothing, keep/discard a parked test run, or discard typed answers. */
function closeQuestion(s: OverlayState, fromBackdrop: boolean, typed: boolean): 'parked' | 'answers' | null {
    if (isParked(s) && s.runId && (s.runKind === 'dry' || s.runKind === 'live')) return 'parked';
    if (fromBackdrop && s.phase === 'form' && typed) return 'answers';
    return null;
}

export default function useFormRunJourney(o: FormRunJourneyOptions) {
    const { t } = useTranslation();
    const [s, dispatch] = useReducer(overlayReducer, { form: o.form, attachRunId: o.attachRunId, runKind: o.runKind, startMode: o.startMode }, initialOverlayState);
    const emit = useCallback((view: FollowView) => dispatch({ type: 'view', view }), []);
    const follower = useFormRunFollower(emit, o.followTiming);
    const typedRef = useRef(false);
    const runId = String(s.runId);

    // Attach mode: pick up the run that is already going (or waiting).
    useEffect(() => {
        if (o.form || !o.attachRunId) return;
        if (o.runKind) follower.follow(o.attachRunId); else follower.attach(o.attachRunId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, []);

    const close = () => { follower.stop(); o.onClose(closeInfo(s)); };
    const setPrompt = (prompt: 'parked' | 'answers' | null) => dispatch({ type: 'prompt', prompt });
    const requestClose = (fromBackdrop: boolean) => {
        if (s.prompt) { setPrompt(null); return; }
        const question = closeQuestion(s, fromBackdrop, typedRef.current);
        if (question) setPrompt(question); else close();
    };

    /** A run started or continued: the overlay follows it, and the canvas a continuation (page one's run is the shell's). */
    const continued = (next: string, answeredPage: boolean, mode?: FormRunMode) => {
        typedRef.current = false;
        dispatch({ type: 'submitted', runId: next, mode, answeredPage });
        if (!mode) o.onFollowRun?.(next);
        follower.follow(next);
    };

    /** Page one starts the run (through the shell); a later page continues the one that is paused. */
    const submit = async ({ website_url: _honeypot, ...answers }: Record<string, unknown>, mode: FormRunMode) => {
        if (s.page.stepId) { continued(await continueRunForm(runId, s.page.stepId, answers), true); return; }
        const out = await o.onStartRun(answers, { mode });
        if (out.kind === 'declined') return;
        if (out.kind !== 'started') throw new Error(out.message || t('automation_testing.overlay.nothing_started', 'Nothing was started.'));
        continued(out.runId, true, mode);
    };

    const upload = async (file: File, field: string): Promise<UploadedFile> => {
        // Only page one's questions have an upload endpoint in the builder; a
        // later page's file question is tried from the test link.
        if (s.page.stepId) throw new Error(t('automation_testing.overlay.later_page_file', 'A file question on a later page can be tried from the form\'s test link.'));
        return uploadFormTestFile(String(o.automationId), file, field, o.triggerStepId);
    };

    return {
        s,
        requestClose,
        close,
        submit,
        upload,
        searchApp: (field: FormFieldDef, query: string) => searchApp(o.automationId, field, query),
        typed: () => { typedRef.current = true; },
        back: () => setPrompt(null),
        decide: async (decision: string, reason?: string, answers?: unknown) => {
            continued(await decideRunApproval(runId, decision, reason, answers), false);
        },
        withdraw: async () => { await discardRun(runId); follower.follow(runId); },
        discardAndClose: async () => { await discardRun(runId); follower.stop(); o.onClose({}); },
        retry: () => { dispatch({ type: 'retry' }); follower.follow(runId); },
    };
}
