/**
 * The manual editor's draft: the fields the person changed, whether that
 * differs from what the server holds, and the one validation the server
 * enforces (a name). Saving is the screen's job (useEditorSave), because a
 * new agent and an existing one save through different routes.
 */

import { useState } from 'react';

import { useTranslation } from '@/core/i18n';

import { sameDraft, validateDraft, type AgentDraft, type DraftErrors } from '../model/draft';
import type { AgentConfig } from '../model/types';

export interface AgentForm {
    draft: AgentDraft;
    dirty: boolean;
    errors: DraftErrors;
    patch: (next: Partial<AgentDraft>) => void;
    patchConfig: (next: Partial<AgentConfig>) => void;
    /** Show the errors; true when the draft may be sent. */
    check: () => boolean;
    /** Adopt what the server now holds (after a save, or "load latest"). */
    reset: (next: AgentDraft) => void;
    discard: () => void;
}

export function useAgentForm(initial: AgentDraft): AgentForm {
    const t = useTranslation();
    const [base, setBase] = useState(initial);
    const [draft, setDraft] = useState(initial);
    const [shown, setShown] = useState(false);
    const errors = shown ? validateDraft(t, draft) : {};

    return {
        draft,
        dirty: !sameDraft(draft, base),
        errors,
        patch: (next) => setDraft((prev) => ({ ...prev, ...next })),
        patchConfig: (next) => setDraft((prev) => ({ ...prev, config: { ...prev.config, ...next } })),
        check: () => {
            setShown(true);
            return Object.keys(validateDraft(t, draft)).length === 0;
        },
        reset: (next) => {
            setBase(next);
            setDraft(next);
            setShown(false);
        },
        discard: () => setDraft(base),
    };
}
