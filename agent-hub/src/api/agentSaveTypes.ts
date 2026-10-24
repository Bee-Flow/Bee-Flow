/**
 * Shared types of the editor's save pipeline (useAgentSave.ts and
 * agentSaveFlows.ts).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

// Agent rows and snapshots are server JSON the editor passes through as is.
export type Loose = any;
export type Setter<T> = Dispatch<SetStateAction<T>>;
export type Ref<T> = MutableRefObject<T>;

export interface EditorSnapshot {
    name: string;
    description: string;
    systemPrompt: string;
    model: string;
    categoryId: string | null;
    embedEnabled: boolean;
    avatar: string;
    config: Record<string, Loose>;
    persona?: Loose;
}

export interface Conflict { currentVersion: Loose; agent: Loose }
export interface LimitWarning { message: string; resource?: Loose }

export interface AgentSaveDeps {
    agent: Loose;
    setAgent: Setter<Loose>;
    ro: boolean;
    roRef: Ref<boolean>;
    mountedRef: Ref<boolean>;
    stateRef: Ref<EditorSnapshot>;
    agentIdRef: Ref<Loose>;
    dirtyRef: Ref<boolean>;
    dirty: boolean;
    setDirty: Setter<boolean>;
    baseVersion: number | null;
    setBaseVersion: Setter<number | null>;
    setForcedReadOnly: Setter<boolean>;
    setInstructions: Setter<string>;
    setLimitWarning: Setter<LimitWarning | null>;
    setChat: Setter<Loose[]>;
    setSavingState: Setter<string>;
    setSaveErrorMsg: Setter<string>;
    setSavedAt: Setter<Date | null>;
    onDirtyChange?: ((dirty: boolean) => void) | null;
    onPublished?: ((agent: Loose) => void) | null;
    /** Re-reads the agent from the server and rehydrates the editor ("Load latest"). */
    handleVersionRestore: () => Promise<void>;
}

export interface SentRefs {
    sentPersonaRef: Ref<Loose>;
    sentSystemPromptRef: Ref<string | undefined>;
}

export interface ConflictCtx {
    conflict: Conflict | null;
    setConflict: Setter<Conflict | null>;
    conflictBusy: boolean;
    setConflictBusy: Setter<boolean>;
    getSnapshot: () => Loose;
    hookMarkSaved: (updated: Loose, version: Loose) => void;
}

