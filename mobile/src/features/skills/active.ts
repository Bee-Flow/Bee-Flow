/**
 * Which skills are switched on for the next message.
 *
 * This is device state, not server state, and that is a deliberate choice
 * rather than a shortcut: the server has no "enabled" column on a skill. What
 * it has is `activeSkillIds` on the chat payload (see SendTurnPayload in
 * src/features/chat/types.ts, and skillInjection.js on the server), a
 * per-request list the composer sends. The web client keeps the same list in
 * React state for the life of a tab; a phone loses that state every time
 * Android reclaims the process, so it is persisted here instead — otherwise
 * "enable this skill" would silently mean "until you switch apps".
 *
 * Kept as a tiny external store rather than context so the list screen, the
 * detail screen and (once it is wired) the composer all read the same value
 * without a provider having to sit above all three.
 *
 * Writes are best-effort. AsyncStorage failing costs the user the toggle after
 * a restart, which is not worth failing a screen over.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useSyncExternalStore } from 'react';

import { ACTIVE_SKILL_CAP } from './types';

const STORAGE_KEY = 'beeflow.skills.active.v1';

interface ActiveSkillState {
    ids: readonly string[];
    /** False until the first read off disk lands, so the UI can hold its toggles. */
    ready: boolean;
}

let state: ActiveSkillState = { ids: [], ready: false };
const listeners = new Set<() => void>();
let hydrating: Promise<void> | null = null;

function emit(next: ActiveSkillState): void {
    state = next;
    for (const listener of listeners) listener();
}

function hydrate(): Promise<void> {
    if (hydrating) return hydrating;
    hydrating = (async () => {
        let stored: readonly string[] = [];
        try {
            const raw = await AsyncStorage.getItem(STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed)) {
                stored = parsed
                    .filter((v): v is string => typeof v === 'string' && v.length > 0)
                    .slice(0, ACTIVE_SKILL_CAP);
            }
        } catch {
            /* an unreadable list is an empty list */
        }
        emit({ ids: stored, ready: true });
    })();
    return hydrating;
}

function persist(ids: readonly string[]): void {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ids)).catch(() => {
        /* see the header — the toggle still works for this run */
    });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    void hydrate();
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): ActiveSkillState {
    return state;
}

/**
 * Turn a skill on or off. Returns false when the cap blocked it, so the caller
 * can say why nothing happened instead of leaving a dead switch.
 */
export function toggleActiveSkill(id: string): boolean {
    if (state.ids.includes(id)) {
        const next = state.ids.filter((v) => v !== id);
        emit({ ids: next, ready: true });
        persist(next);
        return true;
    }
    if (state.ids.length >= ACTIVE_SKILL_CAP) return false;
    const next = [...state.ids, id];
    emit({ ids: next, ready: true });
    persist(next);
    return true;
}

/**
 * Drop ids the library no longer contains.
 *
 * A skill deleted on the web, or one shared with a group this person has left,
 * would otherwise stay switched on forever and be silently dropped by the
 * server on every turn. Call it only after a SUCCESSFUL list — a failed fetch
 * must never be read as "these skills are gone".
 */
export function retainExistingSkills(known: readonly string[]): void {
    if (!state.ready) return;
    const set = new Set(known);
    const next = state.ids.filter((id) => set.has(id));
    if (next.length === state.ids.length) return;
    emit({ ids: next, ready: true });
    persist(next);
}

export interface UseActiveSkills {
    activeSkillIds: readonly string[];
    ready: boolean;
    atCap: boolean;
    isActive: (id: string) => boolean;
    /** False when the cap refused the change. */
    toggle: (id: string) => boolean;
}

export function useActiveSkills(): UseActiveSkills {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const isActive = useCallback((id: string) => snapshot.ids.includes(id), [snapshot.ids]);
    return {
        activeSkillIds: snapshot.ids,
        ready: snapshot.ready,
        atCap: snapshot.ids.length >= ACTIVE_SKILL_CAP,
        isActive,
        toggle: toggleActiveSkill,
    };
}
