/**
 * The test question, streamed: the passages first, the answer as it comes.
 * Asking again aborts the previous answer, and leaving the tab aborts it too,
 * which is what stops the server's model call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '@/core/api/errors';
import type { KbSource } from '@/shared/stream';

import { askKnowledgeBase } from '../api/askEndpoint';

export interface AskState {
    asking: boolean;
    /** null until the passages arrive; `[]` is "nothing matched", an answer in itself. */
    sources: KbSource[] | null;
    answer: string;
    error: string | null;
}

const IDLE: AskState = { asking: false, sources: null, answer: '', error: null };

export function useKbAsk(kbId: string) {
    const [state, setState] = useState<AskState>(IDLE);
    const abort = useRef<AbortController | null>(null);
    useEffect(() => () => abort.current?.abort(), []);

    const ask = useCallback(
        async (question: string) => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;
            setState({ ...IDLE, asking: true });
            let error: string | null = null;
            try {
                for await (const event of askKnowledgeBase(kbId, question, controller.signal)) {
                    if (event.type === 'sources') setState((s) => ({ ...s, sources: event.sources }));
                    else if (event.type === 'text') setState((s) => ({ ...s, answer: s.answer + event.text }));
                    else if (event.type === 'error') error = event.message ?? '';
                }
            } catch (e) {
                if (controller.signal.aborted) return;
                error = describeError(e).message;
            }
            if (!controller.signal.aborted) setState((s) => ({ ...s, asking: false, error }));
        },
        [kbId],
    );

    return { ...state, ask };
}
