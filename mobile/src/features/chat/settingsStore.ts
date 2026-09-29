/**
 * The composer settings that outlive a screen.
 *
 * Two of the three composer settings are a standing preference and one is not,
 * and the difference is the whole reason this file exists.
 *
 *   - `modelTier` and `webSearchEnabled` are things a person decides ONCE and
 *     expects to hold. Before this they were plain `useState` in the chat
 *     screen, so every new chat — and every time Android reclaimed the process
 *     — silently reset them. Someone who had deliberately switched web search
 *     off on a privacy product got it back on without being told.
 *   - `reasoningEffort` is deliberately NOT persisted. It is a per-question
 *     decision (see the note on ReasoningEffort in types.ts), and a remembered
 *     "high" would quietly spend a user's allowance on every trivial question
 *     they asked afterwards.
 *
 * Modelled on features/skills/active.ts, deliberately: an external store rather
 * than context, so the composer, the tier reconciler and the ＋ sheet all read
 * one value without a provider having to sit above all three. Writes are
 * best-effort — AsyncStorage failing costs the setting after a restart, which
 * is not worth failing a screen over.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { ModelTier } from './types';

const STORAGE_KEY = 'beeflow.chat.settings.v1';

export interface ChatPreferences {
    /** `auto` is the one tier the server always offers. */
    modelTier: ModelTier;
    webSearchEnabled: boolean;
}

export const DEFAULT_PREFERENCES: ChatPreferences = {
    modelTier: 'auto',
    // On by default, as it has always been. Making it visible in the composer
    // is a legibility fix, not a policy change — if egress should be off by
    // default on a GDPR product, that is an owner's decision, not this file's.
    webSearchEnabled: true,
};

interface State extends ChatPreferences {
    /** False until the first read off disk lands. */
    ready: boolean;
}

let state: State = { ...DEFAULT_PREFERENCES, ready: false };
const listeners = new Set<() => void>();
let hydrating: Promise<void> | null = null;

function emit(next: State): void {
    state = next;
    for (const listener of listeners) listener();
}

/** Narrow whatever came off disk. An older or corrupt shape is just defaults. */
export function parsePreferences(raw: string | null): ChatPreferences {
    if (!raw) return DEFAULT_PREFERENCES;
    try {
        const parsed = JSON.parse(raw) as Partial<ChatPreferences>;
        return {
            modelTier:
                typeof parsed?.modelTier === 'string' && parsed.modelTier
                    ? parsed.modelTier
                    : DEFAULT_PREFERENCES.modelTier,
            webSearchEnabled:
                typeof parsed?.webSearchEnabled === 'boolean'
                    ? parsed.webSearchEnabled
                    : DEFAULT_PREFERENCES.webSearchEnabled,
        };
    } catch {
        return DEFAULT_PREFERENCES;
    }
}

function hydrate(): Promise<void> {
    if (hydrating) return hydrating;
    hydrating = (async () => {
        let stored = DEFAULT_PREFERENCES;
        try {
            stored = parsePreferences(await AsyncStorage.getItem(STORAGE_KEY));
        } catch {
            /* unreadable is default */
        }
        emit({ ...stored, ready: true });
    })();
    return hydrating;
}

function persist(prefs: ChatPreferences): void {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    void hydrate();
    return () => listeners.delete(listener);
}

function getSnapshot(): State {
    return state;
}

export function setChatPreferences(next: Partial<ChatPreferences>): void {
    const merged: ChatPreferences = {
        modelTier: next.modelTier ?? state.modelTier,
        webSearchEnabled: next.webSearchEnabled ?? state.webSearchEnabled,
    };
    emit({ ...merged, ready: true });
    persist(merged);
}

/**
 * Called by the tier reconciler. A remembered tier can vanish between sessions
 * — a beta flag switched off, a group changed, a custom tier deleted — and
 * sending one the server will not accept fails the turn with an error the user
 * cannot act on.
 */
export function useChatPreferences(): State {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
