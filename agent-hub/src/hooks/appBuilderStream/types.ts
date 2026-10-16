import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
    BuilderEngine,
    BuilderMessage,
    BuilderTodo,
    BuilderTurn,
    BuilderValidation,
} from '../builderStream';

/** What one turn finished with; the caller adopts the drafts and unlocks. */
export interface AppBuilderDoneInfo {
    appId?: string;
    stopped?: boolean;
    [key: string]: unknown;
}

export interface UseAppBuilderStreamOptions {
    appId?: string | null;
    onDraft?: (definition: unknown, version: unknown, appId: unknown, meta: { lastCall: unknown }) => void;
    onDone?: (info: AppBuilderDoneInfo) => void;
    onError?: (message: string, code?: string) => void;
    onDataModel?: (model: unknown) => void;
    onPlan?: (plan: unknown) => void;
    onPhase?: (phase: unknown) => void;
    onCheckpoint?: (checkpoint: unknown) => void;
}

/** What `send` may carry beside the message itself. */
export interface AppBuilderSendOptions {
    message?: string;
    modelTier?: string;
    context?: unknown;
    /** An approved plan — a turn with one needs no text. */
    plan?: unknown;
    /** Data-URL pictures the user attached. */
    images?: string[];
    continueToken?: string;
    [key: string]: unknown;
}

/** The `{ token, nextPhase }` a model hands back when its budget ran out. */
export interface Continuation {
    token?: string;
    nextPhase?: unknown;
    [key: string]: unknown;
}

/** The caller's callbacks, held in refs so `send` never goes stale. */
export interface AppBuilderCallbackRefs {
    onDraft: MutableRefObject<UseAppBuilderStreamOptions['onDraft']>;
    onDone: MutableRefObject<UseAppBuilderStreamOptions['onDone']>;
    onError: MutableRefObject<UseAppBuilderStreamOptions['onError']>;
    onDataModel: MutableRefObject<UseAppBuilderStreamOptions['onDataModel']>;
    onPlan: MutableRefObject<UseAppBuilderStreamOptions['onPlan']>;
    onPhase: MutableRefObject<UseAppBuilderStreamOptions['onPhase']>;
    onCheckpoint: MutableRefObject<UseAppBuilderStreamOptions['onCheckpoint']>;
}

/** The hook's state setters, refs and patchers an event handler writes through. */
export interface AppBuilderStreamDeps {
    appId?: string | null;
    abortRef: MutableRefObject<AbortController | null>;
    sessionIdRef: MutableRefObject<string | null>;
    lastToolCallRef: MutableRefObject<unknown>;
    phasesTotalRef: MutableRefObject<number>;
    cb: AppBuilderCallbackRefs;
    setMessages: Dispatch<SetStateAction<BuilderMessage[]>>;
    setSessionId: Dispatch<SetStateAction<string | null>>;
    setLastValidation: Dispatch<SetStateAction<BuilderValidation | null>>;
    setLastDataModel: Dispatch<SetStateAction<unknown>>;
    setPendingPlan: Dispatch<SetStateAction<unknown>>;
    setPhases: Dispatch<SetStateAction<unknown[]>>;
    setCheckpoints: Dispatch<SetStateAction<unknown[]>>;
    setEngine: Dispatch<SetStateAction<BuilderEngine | null>>;
    setToolDraft: Dispatch<SetStateAction<Record<string, unknown> | null>>;
    setTodos: Dispatch<SetStateAction<BuilderTodo[]>>;
    patchAssistant: (fn: (m: BuilderMessage) => BuilderMessage) => void;
    patchTurn: (fn: (t: BuilderTurn) => Partial<BuilderTurn>) => void;
    markFirstEvent: () => void;
}

/** What a turn's events leave behind for the leg loop (written by `done`). */
export interface TurnOutcome {
    sawDone: boolean;
    errored: boolean;
    continuation: Continuation | null;
    doneInfo: AppBuilderDoneInfo | null;
}

/** One event's view of the turn: the hook's deps plus this leg's options and outcome. */
export interface AppBuilderEventCtx extends AppBuilderStreamDeps {
    options: AppBuilderSendOptions;
    outcome: TurnOutcome;
    fail: (msg: string, code?: string) => void;
}
