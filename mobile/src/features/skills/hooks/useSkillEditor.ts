/**
 * The open skill's draft and its autosave — the web's SkillDetail save loop.
 *
 * Every edit lands in the draft at once and is saved a moment after the last
 * one (SAVE_DEBOUNCE_MS), so typing a step is not a request per keystroke.
 * Two traps, both handled on purpose:
 *
 *   1. STRUCTURE, NEVER TEXT: the PUT body is buildSavePayload, which sends
 *      the structured facets and never `workflow` / `rules` / `examples`.
 *
 *   2. A 403 IS NOT A RETRY: a visible-but-not-editable skill answers 403
 *      `not_editable`. The loop stops, the editor drops to read-only and says
 *      why, once. Any other failure keeps the edit dirty for the next try.
 *
 * `locked` starts from the server's own verdict and only ever gets STRICTER.
 * A pending edit is flushed when the screen goes away, so leaving a skill
 * right after typing does not lose the last words.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { updateSkill } from '../api/endpoints';
import { skillKeys } from '../api/keys';
import { canEditSkill } from '../model/permissions';
import { buildSavePayload, draftOf } from '../model/skillModel';
import type { Skill, SkillDraft } from '../model/types';

export const SAVE_DEBOUNCE_MS = 600;

export type DraftPatch = Partial<SkillDraft> | ((current: SkillDraft) => Partial<SkillDraft>);

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SkillEditor {
    draft: SkillDraft;
    /**
     * Merge fields into the draft; `immediate` saves without waiting. A
     * function is applied to the newest draft, not to one a render captured.
     */
    patch: (next: DraftPatch, immediate?: boolean) => void;
    /** Adopt a draft the server already stored (Improve with AI) — no save. */
    adopt: (next: SkillDraft) => void;
    saveState: SaveState;
    locked: boolean;
    lock: () => void;
    /**
     * Save a pending edit now; resolves once it — and any edit made while an
     * earlier save was on the wire — has landed (or failed).
     */
    flush: () => Promise<void>;
}

function isNotEditable(e: unknown): boolean {
    return e instanceof ApiError && (e.status === 403 || e.code === 'not_editable');
}

function structureField(e: unknown): string | null {
    if (!(e instanceof ApiError) || e.code !== 'invalid_structure') return null;
    const body = e.body as { field?: unknown } | undefined;
    return typeof body?.field === 'string' ? body.field : '';
}

/**
 * What a failed save means, said once as a toast: `stop` for a skill this
 * account may look at but not change, `retry` for anything else. Stable for
 * the screen's life, so the unmount flush that uses it never re-runs.
 */
function useSaveFailure(): (e: unknown) => 'stop' | 'retry' {
    const t = useTranslation();
    const { toast } = useToast();
    const handle = useRef<(e: unknown) => 'stop' | 'retry'>(() => 'retry');
    useEffect(() => {
        handle.current = (e) => {
            if (isNotEditable(e)) {
                toast(t('skills_studio.err_readonly', 'You can see this skill but not change it.'), 'error');
                return 'stop';
            }
            const field = structureField(e);
            if (field !== null) toast(t('skills_studio.err_structure', 'Could not save “{field}” — check that field.', { field }), 'error');
            return 'retry';
        };
    }, [t, toast]);
    return useCallback((e: unknown) => handle.current(e), []);
}

export function useSkillEditor(skill: Skill): SkillEditor {
    const queryClient = useQueryClient();
    const failed = useSaveFailure();
    const [draft, setDraft] = useState<SkillDraft>(() => draftOf(skill));
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [locked, setLocked] = useState(() => !canEditSkill(skill));
    const draftRef = useRef(draft);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The save loop on the wire, if any; every flush resolves with it. */
    const pending = useRef<Promise<void> | null>(null);
    const dirty = useRef(false);
    const alive = useRef(true);
    const id = skill.id;

    /** Save until nothing is dirty: an edit made during a save rides the next one. */
    const drain = useCallback(async (): Promise<void> => {
        try {
            while (dirty.current) {
                dirty.current = false;
                const sent = draftRef.current;
                try {
                    await updateSkill(id, buildSavePayload(sent));
                } catch (e) {
                    if (!alive.current) return;
                    setSaveState('error');
                    const stop = failed(e) === 'stop';
                    dirty.current = !stop;
                    if (stop) setLocked(true);
                    return;
                }
                // The detail row is what the editor seeds from on the next
                // open: carry the saved structure into it, so a reopen within
                // the stale window cannot seed (and later autosave) the old one.
                queryClient.setQueryData<Skill | null>(skillKeys.detail(id), (old) => (old ? { ...old, ...sent } : old));
                void queryClient.invalidateQueries({ queryKey: skillKeys.all });
                if (alive.current && !dirty.current) setSaveState('saved');
            }
        } finally {
            pending.current = null;
        }
    }, [id, queryClient, failed]);

    const flush = useCallback((): Promise<void> => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (pending.current) return pending.current;
        if (!dirty.current) return Promise.resolve();
        pending.current = drain();
        return pending.current;
    }, [drain]);

    const patch = useCallback(
        (next: DraftPatch, immediate = false) => {
            if (locked) return;
            const fields = typeof next === 'function' ? next(draftRef.current) : next;
            const merged = { ...draftRef.current, ...fields };
            draftRef.current = merged;
            setDraft(merged);
            dirty.current = true;
            setSaveState('saving');
            if (timer.current) clearTimeout(timer.current);
            if (immediate) void flush();
            else timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
        },
        [locked, flush],
    );

    const adopt = useCallback((next: SkillDraft) => {
        draftRef.current = next;
        setDraft(next);
        setSaveState('saved');
    }, []);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            if (dirty.current) void flush();
        };
    }, [flush]);

    return { draft, patch, adopt, saveState, locked, lock: () => setLocked(true), flush };
}
