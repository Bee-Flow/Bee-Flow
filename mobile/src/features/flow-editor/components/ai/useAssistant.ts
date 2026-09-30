/**
 * "Ask AI" on the build screen: the builder stream over the routine's draft
 * (hooks/useBuilderStream — the draft is saved first, locked while a turn
 * streams, and the turn's drafts replace it as one undo step), plus what the
 * sheet around it keeps: whether it is open, what is typed, the model tier.
 *
 * Owned by the build screen rather than the sheet, so closing the sheet
 * does not end a turn — the flow keeps changing behind it, and the sheet
 * shows the turn again when it is reopened.
 *
 * The persisted session is the conversation's memory: its transcript
 * (useBuilderStream), and its last findings, which become the store's
 * builder findings when the routine has none yet — the web builder seeds
 * its validation from the same snapshot.
 */

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { describeError } from '@/core/api/errors';
import { useBuilderSession, useBuilderStream, type BuilderStream, type FlowDraft } from '@/features/flow-editor/hooks';
import { useToast } from '@/shared/ui';

export interface Assistant {
    ai: BuilderStream;
    open: boolean;
    setOpen: (open: boolean) => void;
    text: string;
    setText: (text: string) => void;
    tier: string;
    setTier: (tier: string) => void;
    send: (message?: string) => void;
}

/** The session's last findings, as the builder's, when nothing newer is there. */
function useSessionFindings(draft: FlowDraft): void {
    const automationId = useStore(draft.store, (s) => s.automationId);
    const session = useBuilderSession(automationId);
    const last = session.data?.lastValidation ?? null;
    useEffect(() => {
        if (!last) return;
        const current = draft.store.getState().issueSources.builder;
        if (!current.errors.length && !current.warnings.length) draft.store.getState().setIssues('builder', last);
    }, [draft.store, last]);
}

export function useAssistant(draft: FlowDraft): Assistant {
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [tier, setTier] = useState('auto');
    const ai = useBuilderStream(draft, { modelTier: tier });
    useSessionFindings(draft);
    const send = (message?: string) => {
        const body = (message ?? text).trim();
        if (!body || ai.streaming) return;
        setText('');
        ai.send(body).catch((err: unknown) => {
            setText(body);
            toast(describeError(err).message, 'error');
        });
    };
    return { ai, open, setOpen, text, setText, tier, setTier, send };
}
