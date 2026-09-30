/**
 * One test run, streamed: the answer first, then the graded verdict.
 *
 * The stream must END on purpose — `done` or `error`. Anything else is a cut
 * body (a proxy closing a close-delimited response looks exactly like a clean
 * end), and a run without a verdict may not be drawn as a run that found
 * nothing: it becomes the `stream_cut` message instead. Leaving the screen
 * aborts the request, which is what stops the server spending tokens.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';

import { skillKeys } from '../api/keys';
import { runSkillTest } from '../api/testEndpoints';
import { testErrorMessage } from '../model/testRun';
import type { TestRun } from '../model/types';

export interface SkillTestState {
    running: boolean;
    answer: string;
    run: TestRun | null;
    error: string | null;
    /** Set when the server searched fewer knowledge bases than the skill links. */
    kbNotice: { declared: number; used: number } | null;
}

const IDLE: SkillTestState = { running: false, answer: '', run: null, error: null, kbNotice: null };

export function useSkillTest(skillId: string) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const [state, setState] = useState<SkillTestState>(IDLE);
    const abort = useRef<AbortController | null>(null);

    useEffect(() => () => abort.current?.abort(), []);

    const start = useCallback(
        async (input: { agentId: string | null; question: string }) => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;
            setState({ ...IDLE, running: true });
            let verdict: TestRun | null = null;
            let failure: string | null = null;
            try {
                for await (const event of runSkillTest(skillId, input, controller.signal)) {
                    if (event.type === 'answer') setState((s) => ({ ...s, answer: event.text }));
                    else if (event.type === 'kb_dropped') setState((s) => ({ ...s, kbNotice: { declared: event.declared, used: event.used } }));
                    else if (event.type === 'done') verdict = event.run;
                    else failure = testErrorMessage(t, event.code, event.message);
                }
                if (!failure && !verdict) failure = testErrorMessage(t, 'stream_cut');
            } catch (e) {
                if (controller.signal.aborted) return;
                failure = testErrorMessage(t, e instanceof ApiError ? e.code : undefined, describeError(e).message);
            }
            if (controller.signal.aborted) return;
            setState((s) => ({ ...s, running: false, run: failure ? null : verdict, error: failure }));
            if (verdict) void queryClient.invalidateQueries({ queryKey: skillKeys.testRuns(skillId) });
        },
        [skillId, t, queryClient],
    );

    return { ...state, start };
}
