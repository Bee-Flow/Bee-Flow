/**
 * The AI builder's stream, as a surface adapter for the shared stream stack.
 *
 * POST /api/automation/builder/stream (routes/ai/automationBuilder/
 * chatStream.js, with modelStream.js, thoughtNarrator.js and
 * layerDelegation.js writing into it). Its vocabulary is not chat's: beside
 * the reply and the reasoning it streams the DRAFT the model is building, the
 * validator's findings, a checklist, and a dry run. The web reads it in
 * agent-hub/src/hooks/useAutomationBuilderStream.ts; builderStream.lockstep
 * .test.ts holds this table to both that switch and the server's emitters.
 *
 * Frames that are about the routine rather than the turn — a new draft, new
 * findings, the id of a routine the turn created, a new name — are ALSO
 * handed to the screen through callbacks, so the draft store can adopt them
 * as they arrive instead of after the turn.
 */

import { field, pick } from '@/core/api/contract';
import { translate } from '@/core/i18n';
import { readRun, readRunStep, type AutomationRun, type AutomationRunStep } from '@/features/automations';
import { IGNORE, type FrameAdapter, type FrameData, type FrameHandler, type TurnBase } from '@/shared/stream';
import { appendThinkingText, modelSelected, str, thinkingStarted, thinkingStopped } from '@/shared/stream/handlers';

import {
    readBuilderSnapshot,
    readTodos,
    readToolCall,
    readValidation,
    type BuilderSnapshot,
    type BuilderTodo,
    type BuilderToolCall,
    type BuilderValidation,
} from './builder';
import { normalizeDefinitionShape } from '../model/normalize';
import type { FlowDefinition } from '../model/types';

export interface BuilderTurn extends TurnBase {
    /** The assistant's reply so far. */
    text: string;
    thinking: string;
    thinkingActive: boolean;
    /** The narrator's one-line gloss of the reasoning, when the server runs one; `seq` orders them. */
    thinkingSummary: { text: string; seq: number } | null;
    /** 'reading' while the model reads its prompt, 'building' while it types a tool call. */
    phase: 'reading' | 'building' | null;
    modelId: string | null;
    builderSessionId: string | null;
    automationId: string | null;
    toolCalls: BuilderToolCall[];
    /** The tool call being typed right now: its name and how many steps it holds so far. */
    toolDraft: { name: string | null; count: number } | null;
    todos: BuilderTodo[];
    /** The latest draft this turn produced, and how many it produced. */
    draft: FlowDefinition | null;
    draftCount: number;
    validation: BuilderValidation | null;
    summary: { text: string; hasSideEffects: boolean } | null;
    dryRun: { run: AutomationRun | null; steps: AutomationRunStep[]; running: boolean } | null;
    finalizedId: string | null;
    title: string | null;
    /** The flowlet a delegated agent is building, while it does. */
    layerAgent: string | null;
    aborted: { reason: string; iterations: number | null } | null;
    /** The session the server replayed on `?resume=1`. */
    resumed: BuilderSnapshot | null;
    /** An `error` frame that says the draft is safe and the message can simply be sent again. */
    transient: boolean;
}

export function emptyBuilderTurn(): BuilderTurn {
    return {
        text: '',
        thinking: '',
        thinkingActive: false,
        thinkingSummary: null,
        phase: null,
        modelId: null,
        builderSessionId: null,
        automationId: null,
        toolCalls: [],
        toolDraft: null,
        todos: [],
        draft: null,
        draftCount: 0,
        validation: null,
        summary: null,
        dryRun: null,
        finalizedId: null,
        title: null,
        layerAgent: null,
        aborted: null,
        resumed: null,
        transient: false,
        error: null,
        done: false,
    };
}

/** What the screen and the draft store want to know as it happens. */
export interface BuilderFrameCallbacks {
    /** The server now knows (or created) the routine and the builder session. */
    onSession?: (ids: { automationId: string | null; builderSessionId: string | null }) => void;
    /** A new draft, already persisted server-side. */
    onDraft?: (definition: FlowDefinition, automationId: string | null) => void;
    onValidation?: (validation: BuilderValidation) => void;
    onFinalized?: (automationId: string) => void;
    /** The routine's name changed (builder_set_metadata, or the server's own fallback). */
    onMetadata?: (title: string) => void;
}

const idOf = (d: FrameData): string | null => str(d.automationId) || null;

const session = (callbacks: () => BuilderFrameCallbacks): FrameHandler<BuilderTurn> => (turn, d) => {
    turn.builderSessionId = str(d.builderSessionId) || turn.builderSessionId;
    turn.automationId = idOf(d) || turn.automationId;
    callbacks().onSession?.({ automationId: turn.automationId, builderSessionId: turn.builderSessionId });
};

const draft = (callbacks: () => BuilderFrameCallbacks): FrameHandler<BuilderTurn> => (turn, d) => {
    const definition = normalizeDefinitionShape(d.definition);
    if (!definition) return false;
    turn.draft = definition;
    turn.draftCount += 1;
    turn.automationId = idOf(d) || turn.automationId;
    callbacks().onDraft?.(definition, turn.automationId);
};

const validation = (callbacks: () => BuilderFrameCallbacks): FrameHandler<BuilderTurn> => (turn, d) => {
    const found = readValidation(d) ?? { errors: [], warnings: [] };
    turn.validation = found;
    callbacks().onValidation?.(found);
};

const finalized = (callbacks: () => BuilderFrameCallbacks): FrameHandler<BuilderTurn> => (turn, d) => {
    turn.finalizedId = idOf(d) || turn.automationId;
    if (turn.finalizedId) callbacks().onFinalized?.(turn.finalizedId);
};

const metadata = (callbacks: () => BuilderFrameCallbacks): FrameHandler<BuilderTurn> => (turn, d) => {
    if (typeof d.title !== 'string') return false;
    turn.title = d.title;
    callbacks().onMetadata?.(d.title);
};

const dryRunFinished: FrameHandler<BuilderTurn> = (turn, d) => {
    const run = pick(d, 'run');
    turn.dryRun = {
        run: run && typeof run === 'object' ? readRun(run) : null,
        steps: field.list(readRunStep)(d.steps),
        running: false,
    };
};

const failed: FrameHandler<BuilderTurn> = (turn, d) => {
    turn.error = str(d.error) || translate('mobile.flow.builder_error', 'The builder reported an error.');
    turn.transient = d.transient === true;
    turn.done = true;
};

/**
 * Replace the thinking gloss — unless this one is older than what is shown:
 * `seq` is monotonic per turn, and a late answer is about text already gone.
 */
const thinkingSummary: FrameHandler<BuilderTurn> = (turn, d) => {
    const seq = field.num(0)(d.seq);
    const text = str(d.text);
    if (!text || (turn.thinkingSummary && turn.thinkingSummary.seq > seq)) return false;
    turn.thinkingSummary = { text, seq };
};

/** `callbacks` is read per frame, so a re-rendered screen's latest ones are used. */
export function builderFrames(callbacks: () => BuilderFrameCallbacks): FrameAdapter<BuilderTurn> {
    return {
        builder_session: session(callbacks),
        message: (turn, d) => {
            turn.text += str(d.content);
            turn.phase = null;
        },
        thinking_start: thinkingStarted,
        thinking: appendThinkingText,
        thinking_stop: thinkingStopped,
        thinking_summary: thinkingSummary,
        model_selected: modelSelected,
        round_start: (turn, d) => {
            turn.phase = 'reading';
            turn.toolDraft = null;
            turn.modelId = str(d.modelId) || turn.modelId;
        },
        tool_draft: (turn, d) => {
            turn.phase = 'building';
            turn.toolDraft = { name: str(d.name) || null, count: field.num(0)(d.count) };
        },
        tool_call: (turn, d) => {
            const call = readToolCall(d);
            if (call.name) turn.toolCalls = [...turn.toolCalls, call];
            turn.toolDraft = null;
        },
        plan: (turn, d) => {
            turn.todos = readTodos(d.todos).filter((t) => t.text !== '');
        },
        draft: draft(callbacks),
        validation_errors: validation(callbacks),
        summary: (turn, d) => {
            turn.summary = { text: str(d.summary), hasSideEffects: d.hasSideEffects === true };
        },
        dryrun_started: (turn) => {
            turn.dryRun = { run: null, steps: [], running: true };
        },
        dryrun: dryRunFinished,
        finalized: finalized(callbacks),
        metadata: metadata(callbacks),
        layer_agent_start: (turn, d) => {
            turn.layerAgent = str(d.layerKey) || null;
        },
        layer_agent_done: (turn) => {
            turn.layerAgent = null;
        },
        builder_aborted: (turn, d) => {
            turn.aborted = { reason: str(d.reason), iterations: field.numOrNull(d.iterations) };
            turn.toolDraft = null;
        },
        resume: (turn, d) => {
            turn.resumed = d.snapshot && typeof d.snapshot === 'object' ? readBuilderSnapshot(d.snapshot) : null;
        },
        error: failed,
        done: (turn, d) => {
            turn.done = true;
            turn.thinkingActive = false;
            turn.finalizedId = d.finalized === true ? idOf(d) || turn.finalizedId : turn.finalizedId;
        },

        // The heartbeat, and the local-model engine telemetry the desktop's
        // waiting card draws (prefill progress, per-round token usage).
        ping: IGNORE,
        prompt_progress: IGNORE,
        usage: IGNORE,
    };
}
