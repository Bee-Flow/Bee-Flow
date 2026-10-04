/**
 * The owner's edits to a form — the web's useFormDetail on the phone's draft
 * store.
 *
 * The automation is opened in the flow editor's draft store (useFlowDraft), the
 * same store the build screen edits, so the Form page and the automation builder
 * never hold two versions of one form. The Questions tab edits a DRAFT of the
 * trigger's form and nothing reaches the store until Save — as on the web, a
 * misread AI brief is one "Discard", never a retired answers column. Save
 * writes the form into the definition and flushes the store's own PUT.
 *
 * While the draft is clean it follows what was saved (a change made in the
 * builder, an AI turn); once edited, it is the person's until they save or
 * discard it.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { translate } from '@/core/i18n';
import { useDraftState, useFlowDraft, type FormDeclaration } from '@/features/flow-editor';

import { refreshForms } from './mutations';
import { cloneForm, sameForm, triggerFormOf, withTriggerForm } from '../model/questionsDraft';

export interface QuestionsDraft {
    /** The automation is loaded and its trigger is a form. */
    ready: boolean;
    draft: FormDeclaration | null;
    saved: FormDeclaration | null;
    setDraft: (next: FormDeclaration) => void;
    dirty: boolean;
    saving: boolean;
    saveError: unknown;
    /** Edits are refused while the AI builder streams into this automation. */
    locked: boolean;
    save: () => Promise<boolean>;
    discard: () => void;
    /** Change the SAVED form (a rename, collecting on or off) and keep any unsaved draft. */
    patchSaved: (patch: Partial<FormDeclaration>) => Promise<boolean>;
    loadError: unknown;
}

function refusedWords(locked: boolean): string {
    return locked
        ? translate('automations.builder.edits_locked', 'The AI is building this automation — editing is paused until it finishes.')
        : translate('forms.page.save_failed', 'Could not save the form.');
}

interface Held {
    base: FormDeclaration | null;
    draft: FormDeclaration | null;
}

function useHeldDraft(saved: FormDeclaration | null) {
    const [held, setHeld] = useState<Held>({ base: null, draft: null });
    if (saved !== held.base) {
        const clean = held.draft === null || sameForm(held.draft, held.base);
        setHeld(clean ? { base: saved, draft: saved ? cloneForm(saved) : null } : { base: saved, draft: held.draft });
    }
    return [held, setHeld] as const;
}

export function useQuestionsDraft(automationId: string): QuestionsDraft {
    const queryClient = useQueryClient();
    const flow = useFlowDraft(automationId);
    const saved = useDraftState(flow.store, (s) => triggerFormOf(s.definition));
    const locked = useDraftState(flow.store, (s) => s.locked);
    const [held, setHeld] = useHeldDraft(saved);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<unknown>(null);

    const commit = async (form: FormDeclaration): Promise<boolean> => {
        setSaving(true);
        setSaveError(null);
        try {
            const store = flow.store.getState();
            // The store refuses edits while the AI builder streams into the
            // automation (and before it has loaded): that is a failed save, not a
            // saved one — a flush would say "nothing unsaved".
            const written = store.applyOp((definition) => withTriggerForm(definition, form));
            if (!written && !sameForm(triggerFormOf(store.definition), form)) {
                setSaveError(new Error(refusedWords(store.locked)));
                return false;
            }
            const ok = await store.flush();
            if (!ok) {
                setSaveError(flow.store.getState().saveError?.error ?? new Error(translate('forms.page.save_failed', 'Could not save the form.')));
                return false;
            }
            refreshForms(queryClient);
            return true;
        } finally {
            setSaving(false);
        }
    };

    return {
        ready: saved !== null,
        draft: held.draft,
        saved,
        setDraft: (next) => setHeld((h) => ({ ...h, draft: next })),
        dirty: !!held.draft && !!saved && !sameForm(held.draft, saved),
        saving,
        saveError,
        locked,
        save: async () => (held.draft ? commit(held.draft) : false),
        discard: () => setHeld((h) => ({ ...h, draft: saved ? cloneForm(saved) : null })),
        patchSaved: async (patch) => {
            if (!saved) return false;
            setHeld((h) => ({ ...h, draft: h.draft ? { ...h.draft, ...patch } : h.draft }));
            return commit({ ...saved, ...patch });
        },
        loadError: flow.error,
    };
}
