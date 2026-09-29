/**
 * useDlpDecision — client-side glue for the pre-flight DLP preview modal.
 *
 * The server emits `dlp_preview` when a prompt needs user review (sensitive
 * content detected, provider is external, org mode is 'ask'). This hook
 * listens for those events via a custom window event bus (dispatched from
 * the chat SSE reducer) and drives the `<DlpPreviewModal>` component.
 *
 * Flow:
 *   1. SSE handler dispatches window event 'beeflow:dlp_preview' with detail.
 *   2. Hook stores it in `pending`, which renders the modal.
 *   3. User picks Redact / Block / Allow → we POST `/api/chat/dlp-decision`.
 *   4. Hook clears `pending`.
 */

import { useCallback, useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/** What the SSE reducer puts on the event. The modal feature-detects the
 *  richer fields (`reviewText`, `provider`, …), so only the id is named. */
export interface DlpPreviewDetail {
    decisionId?: string;
    [key: string]: unknown;
}

export type DlpPending = DlpPreviewDetail & { kind: 'chat_text' | 'attachment' };

export type DlpChoice = 'redact' | 'block' | 'allow';

/** A span the user marked in the review UI; the server redacts exactly these. */
export interface DlpManualAddition {
    start: number;
    end: number;
    [key: string]: unknown;
}

export interface DlpSubmitOptions {
    rememberForConversation?: boolean;
    manualAdditions?: DlpManualAddition[];
}

export interface UseDlpDecisionReturn {
    pending: DlpPending | null;
    submit: (choice: DlpChoice, opts?: DlpSubmitOptions) => Promise<void>;
    cancel: () => void;
    submitting: boolean;
    error: string | null;
}

declare global {
    interface WindowEventMap {
        'beeflow:dlp_preview': CustomEvent<DlpPreviewDetail>;
        'beeflow:dlp_attachment_preview': CustomEvent<DlpPreviewDetail>;
        'beeflow:dlp_resolved': CustomEvent<unknown>;
        'beeflow:dlp_blocked': CustomEvent<unknown>;
    }
}

export default function useDlpDecision(): UseDlpDecisionReturn {
    const [pending, setPending] = useState<DlpPending | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const onPreview = (e: CustomEvent<DlpPreviewDetail>) => {
            setPending({ kind: 'chat_text', ...(e.detail || {}) });
            setError(null);
        };
        const onAttachmentPreview = (e: CustomEvent<DlpPreviewDetail>) => {
            setPending({ kind: 'attachment', ...(e.detail || {}) });
            setError(null);
        };
        const onResolved = () => {
            // The modal closes itself when the decision is sent, but if another
            // client path resolves first (e.g. a second tab), clear here too.
            setPending(null);
        };
        const onBlocked = () => setPending(null);

        window.addEventListener('beeflow:dlp_preview', onPreview);
        window.addEventListener('beeflow:dlp_attachment_preview', onAttachmentPreview);
        window.addEventListener('beeflow:dlp_resolved', onResolved);
        window.addEventListener('beeflow:dlp_blocked', onBlocked);
        return () => {
            window.removeEventListener('beeflow:dlp_preview', onPreview);
            window.removeEventListener('beeflow:dlp_attachment_preview', onAttachmentPreview);
            window.removeEventListener('beeflow:dlp_resolved', onResolved);
            window.removeEventListener('beeflow:dlp_blocked', onBlocked);
        };
    }, []);

    const submit = useCallback(async (
        choice: DlpChoice,
        { rememberForConversation = false, manualAdditions }: DlpSubmitOptions = {},
    ) => {
        if (!pending?.decisionId) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/chat/dlp-decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    decisionId: pending.decisionId,
                    choice,
                    rememberForConversation,
                    // Spans the user marked in the review UI — only meaningful
                    // for 'redact', omitted entirely for 'block'/'allow'.
                    ...(Array.isArray(manualAdditions) && manualAdditions.length > 0 ? { manualAdditions } : {}),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Request failed (${res.status})`);
            }
            setPending(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to send decision.');
        } finally {
            setSubmitting(false);
        }
    }, [pending]);

    const cancel = useCallback(() => {
        // Default cancel = block, matching the server's fail-closed timeout behaviour.
        submit('block');
    }, [submit]);

    return { pending, submit, cancel, submitting, error };
}
