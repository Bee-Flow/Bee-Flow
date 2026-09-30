/**
 * The AI builder (routes/ai/automationBuilder, mounted at
 * /api/automation/builder): the persisted session a conversation resumes
 * from, and the body of one streamed turn.
 *
 * The stream itself is read by builderStream.ts through the shared stream
 * stack; this file is the plain HTTP half.
 */

import { api, ApiError } from '@/core/api/client';
import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';
import { readIssues } from '@/features/automations';

import type { IssueSet } from './types';
import { normalizeDefinitionShape } from '../model/normalize';
import type { FlowDefinition } from '../model/types';

export const BUILDER_STREAM_PATH = '/api/automation/builder/stream';

/** A step a builder call created — its own answer, `result.added`. */
export interface BuilderAddedStep {
    id: string | null;
    type: string | null;
    tool: string | null;
    label: string | null;
}

/** One tool the builder ran, as the transcript lists it. */
export interface BuilderToolCall {
    name: string;
    /** The builder's refusal of this call, when it refused. */
    error: string | null;
    /** How to fix a refusal (`result._fixHint`), when the builder gave one. */
    hint?: string;
    /** The step(s) the call created: one object for most tools, a list from builder_add_steps. */
    added?: BuilderAddedStep[];
    /** The call reported its steps as a LIST (builder_add_steps), even a list of one. */
    batch?: boolean;
}

export interface BuilderMessage {
    role: 'user' | 'assistant';
    content: string;
    toolCalls: BuilderToolCall[];
}

/** One item of the checklist the model keeps while it builds (builder_set_plan). */
export interface BuilderTodo {
    text: string;
    done: boolean;
}

/** What the validator said about the draft after a builder mutation. */
export type BuilderValidation = IssueSet;

/** GET /builder/session/:automationId — written at the end of every turn (stores/automationStore/builderSessions.js). */
export interface BuilderSnapshot {
    sessionId: string | null;
    version: number | null;
    draft: FlowDefinition | null;
    lastValidation: BuilderValidation | null;
    summary: string;
    conversation: BuilderMessage[];
    todos: BuilderTodo[];
    updatedAt: string | null;
}

export const readTodos: (raw: unknown) => BuilderTodo[] = shapeListOf({ text: field.str(''), done: field.bool(false) });

const readAddedStep: (raw: unknown) => BuilderAddedStep = shapeOf({
    id: (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null),
    type: field.strOrNull,
    tool: field.strOrNull,
    label: field.strOrNull,
});

const isRecord = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A tool call's name, its error when the result carried one, and — when it
 * made steps — what it made, so the activity list can name them by their
 * own type instead of the tool's (the web's toolCallDisplay.js reads the
 * same `result.added` and `_fixHint`).
 */
export function readToolCall(raw: unknown): BuilderToolCall {
    const result = pick(raw, 'result');
    const added = pick(result, 'added');
    const steps = (Array.isArray(added) ? added : isRecord(added) ? [added] : []).filter(isRecord).map(readAddedStep);
    const hint = field.strOrNull(pick(result, '_fixHint'));
    return {
        name: field.str('')(pick(raw, 'name')),
        error: field.strOrNull(pick(result, 'error')),
        ...(hint ? { hint } : {}),
        ...(steps.length ? { added: steps, batch: Array.isArray(added) } : {}),
    };
}

function readMessage(raw: unknown): BuilderMessage | null {
    const role = field.oneOfOrNull(['user', 'assistant'] as const)(pick(raw, 'role'));
    if (!role) return null;
    const calls = pick(raw, 'toolCalls');
    return {
        role,
        content: field.str('')(pick(raw, 'content')),
        toolCalls: Array.isArray(calls) ? calls.map(readToolCall).filter((c) => c.name !== '') : [],
    };
}

export function readValidation(raw: unknown): BuilderValidation | null {
    if (!raw || typeof raw !== 'object') return null;
    return { errors: readIssues(pick(raw, 'errors'), 'error'), warnings: readIssues(pick(raw, 'warnings'), 'warning') };
}

/** The summary is a sentence; an older session stored the tool's `{summary}` result whole. */
function readSummary(raw: unknown): string {
    return typeof raw === 'string' ? raw : field.str('')(pick(raw, 'summary'));
}

export function readBuilderSnapshot(raw: unknown): BuilderSnapshot {
    const conversation = pick(raw, 'conversation');
    return {
        sessionId: field.strOrNull(pick(raw, 'sessionId')),
        version: field.numOrNull(pick(raw, 'version')),
        draft: normalizeDefinitionShape(pick(raw, 'draft')),
        lastValidation: readValidation(pick(raw, 'lastValidation')),
        summary: readSummary(pick(raw, 'summary')),
        conversation: Array.isArray(conversation)
            ? conversation.map(readMessage).filter((m): m is BuilderMessage => m !== null)
            : [],
        todos: readTodos(pick(raw, 'todos')).filter((t) => t.text !== ''),
        updatedAt: field.strOrNull(pick(raw, 'updatedAt')),
    };
}

/**
 * The persisted conversation for a routine, or null when it has none (the
 * route answers 404 for "no session yet", which is not a failure here).
 */
export async function getBuilderSession(automationId: string, signal?: AbortSignal): Promise<BuilderSnapshot | null> {
    try {
        const res = await api.get<unknown>(`/api/automation/builder/session/${encodeURIComponent(automationId)}`, { signal });
        const snapshot = pick(res, 'snapshot');
        return snapshot && typeof snapshot === 'object' ? readBuilderSnapshot(snapshot) : null;
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
    }
}

export interface BuilderTurnInput {
    message: string;
    /** Null on a routine that does not exist yet: the server creates the draft and says so in `builder_session`. */
    automationId: string | null;
    builderSessionId: string | null;
    /** The whole transcript, deliberately unwindowed — the server decides how much reaches the model. */
    history: { role: 'user' | 'assistant'; content: string }[];
    modelTier?: string;
    timezone?: string;
    /** The flowlet on screen, as a hint for the model's default scope. */
    canvasScope?: string | null;
    /** A name for the draft this turn CREATES; ignored for an existing one. */
    seedMetadata?: { title?: string; description?: string } | null;
}

function deviceTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    } catch {
        return 'Europe/Amsterdam';
    }
}

/**
 * The body of one turn: exactly the keys TurnBody accepts (a strict schema —
 * a misspelled key is a 400, not a silent default on a paid turn).
 */
export function builderTurnBody(input: BuilderTurnInput): Record<string, unknown> {
    return {
        message: input.message,
        modelTier: input.modelTier || 'auto',
        timezone: input.timezone || deviceTimezone(),
        builderSessionId: input.builderSessionId,
        automationId: input.automationId,
        history: input.history,
        attachments: [],
        webSearchEnabled: true,
        disabledMedia: {},
        canvasScope: input.canvasScope || null,
        ...(input.seedMetadata ? { seedMetadata: input.seedMetadata } : {}),
    };
}
