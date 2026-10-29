import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { toast } from '@/components/shared/Toast';
import { skillsApi } from '@/api/skillsApi';
import { buildSavePayload } from './skillModel';
import type { JsonResourceError } from '@/api/client';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { SkillDraft } from './skillModel.types';

const SAVE_DEBOUNCE_MS = 350;

export interface SkillAutosaveArgs {
    skillId: string;
    /** The draft the editor opened with; the ref the flush reads starts from it. */
    initialDraft: SkillDraft;
    locked: boolean;
    onSaved: ((patch: { id: string }) => void) | undefined;
    t: TranslateFn;
    setDraft: Dispatch<SetStateAction<SkillDraft>>;
    setSaveState: Dispatch<SetStateAction<string>>;
    setLastSavedAt: Dispatch<SetStateAction<Date | null>>;
    setLocked: Dispatch<SetStateAction<boolean>>;
}

/**
 * The skill editor's autosave: 350ms after the last edit, one save on the
 * wire at a time, a 403 stops the loop (see SkillDetail.types.ts). Moved out
 * of SkillDetail.tsx verbatim, in the same hook order; the state it writes
 * stays in SkillDetail.
 */
export function useSkillAutosave({
    skillId, initialDraft, locked, onSaved, t, setDraft, setSaveState, setLastSavedAt, setLocked,
}: SkillAutosaveArgs) {
    const draftRef = useRef(initialDraft);
    const timerRef = useRef<NodeJS.Timeout>(null);
    const inflightRef = useRef(false);
    const dirtyRef = useRef(false);
    const aliveRef = useRef(true);
    useEffect(() => () => {
        aliveRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const flush = useCallback(async function doFlush() {
        if (!skillId || !dirtyRef.current) return;
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (inflightRef.current) {
            // A save is already on the wire. Come back right after it lands
            // instead of returning: dropping out here would silently lose
            // every keystroke typed during a slow save.
            timerRef.current = setTimeout(() => { timerRef.current = null; doFlush(); }, 120);
            return;
        }
        dirtyRef.current = false;
        inflightRef.current = true;
        try {
            await skillsApi.update(skillId, buildSavePayload(draftRef.current));
            if (!aliveRef.current) return;
            setSaveState('saved');
            setLastSavedAt(new Date());
            onSaved?.({ id: skillId, ...draftRef.current });
        } catch (e) {
            if (!aliveRef.current) return;
            setSaveState('error');
            if ((e as JsonResourceError).status === 403 || (e as JsonResourceError).code === 'not_editable') {
                // Stop the loop: this account may look but not touch.
                setLocked(true);
                dirtyRef.current = false;
                toast.error(t('skills_studio.err_readonly', 'You can see this skill but not change it.'));
            } else {
                // Anything else is worth another try on the next edit.
                dirtyRef.current = true;
                if ((e as JsonResourceError).code === 'invalid_structure') {
                    toast.error(t('skills_studio.err_structure', 'Could not save “{field}” — check that field.', { field: (e as JsonResourceError).field || '' }));
                }
            }
        } finally {
            inflightRef.current = false;
        }
    }, [skillId, onSaved, t, setSaveState, setLastSavedAt, setLocked]);

    const queue = useCallback((immediate: boolean) => {
        if (!skillId || locked) return;
        dirtyRef.current = true;
        setSaveState('saving');
        if (timerRef.current) clearTimeout(timerRef.current);
        if (immediate) { timerRef.current = null; flush(); }
        else timerRef.current = setTimeout(() => { timerRef.current = null; flush(); }, SAVE_DEBOUNCE_MS);
    }, [skillId, locked, flush, setSaveState]);

    /**
     * Every edit goes through here: the ref the flush reads is updated
     * SYNCHRONOUSLY (so a save fired in the same tick sends the new value),
     * then the state, then the queue. Merging inside the setState updater
     * would put a side effect in a function React is allowed to call twice.
     */
    const patch = useCallback((next: Partial<SkillDraft>, immediate: boolean = false) => {
        const merged = { ...draftRef.current, ...next };
        draftRef.current = merged;
        setDraft(merged);
        queue(immediate);
    }, [queue, setDraft]);

    const flushNow = () => { if (dirtyRef.current) flush(); };

    return { draftRef, dirtyRef, flush, patch, flushNow };
}
