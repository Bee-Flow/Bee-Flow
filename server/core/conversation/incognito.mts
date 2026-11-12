/**
 * incognito.mts: the rules of an incognito chat, in one place.
 *
 * An incognito chat (a direct chat with a model, or an agent chat) leaves
 * NOTHING of the conversation behind on the server: no conversation row, no
 * messages, no title, no project assignment, no memory read or written, no
 * uploaded file. The browser tab holds the conversation and sends the whole
 * history with every turn; when the person leaves, it is gone.
 *
 * What stays is what every turn leaves that holds no content: the usage and
 * cost row (tokens, model; budgets need it), guardrail events (metadata), the
 * tool egress log (categories) and the KB query log (the organisation's own
 * attested compliance log). A tool the person asks for still has its real
 * effect, as in a normal chat.
 *
 * Both turn routes call this module (routes/ai/directChat/streamTurn.js and
 * routes/agents/chat.js), so neither owns a copy of the rules:
 *
 *   - `assertIncognitoRequest` refuses what cannot be incognito, with a 400
 *     and one of INCOGNITO_CODES, before the stream opens;
 *   - `applyIncognitoPolicy` turns memory off on the request itself, so every
 *     reader of the per-chat flags (prompt injection, extraction, the memory
 *     tools) gets the same answer whatever the client sent;
 *   - `withholdIncognitoTools` takes the tools that read or keep conversation
 *     state off the offered list;
 *   - `incognitoDonePayload` drops the conversation id from the `done` event.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** The `code` of each refusal; the clients read these. */
export const INCOGNITO_CODES = Object.freeze({
    /** An incognito turn names a stored conversation. */
    conversationId: 'incognito_conversation_id',
    /** An incognito turn carries files: those are uploaded to storage, so they are refused instead. */
    attachments: 'incognito_no_attachments',
    /** A mode that needs a stored conversation (Swarm) or is a different thing altogether (an agent test chat). */
    unsupportedMode: 'incognito_unsupported_mode',
});

export type IncognitoSurface = 'direct' | 'agent';

export interface IncognitoRefusal {
    code: string;
    message: string;
}

interface TurnBodyFields {
    incognito?: unknown;
    conversationId?: unknown;
    attachments?: unknown;
    modelTier?: unknown;
    test?: unknown;
    memoryReadEnabled?: unknown;
    memoryWriteEnabled?: unknown;
    ephemeral?: unknown;
}

/**
 * The tools an incognito turn is not offered. Memory reads and writes the
 * person's long-term memory; the notebook tools keep the notebook on the
 * conversation row (and refuse without one). Names, not modules: requiring
 * the tool modules here would pull core into the integrations import cycle.
 * incognito.test.js checks this list against the real tool definitions.
 */
export const INCOGNITO_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
    'memory_search', 'memory_remember',
    'notebook_read', 'notebook_write', 'notebook_replace', 'notebook_insert',
]);

function fieldsOf(body: unknown): TurnBodyFields {
    return body && typeof body === 'object' ? body as TurnBodyFields : {};
}

/** Is this turn incognito? Only the boolean true is. */
export function isIncognito(body: unknown): boolean {
    return fieldsOf(body).incognito === true;
}

function present(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

/** Why this incognito turn cannot run, or null when it can (or is not incognito). */
export function incognitoRefusal(body: unknown, surface: IncognitoSurface): IncognitoRefusal | null {
    const b = fieldsOf(body);
    if (b.incognito !== true) return null;
    if (present(b.conversationId)) {
        return { code: INCOGNITO_CODES.conversationId, message: 'An incognito chat is not stored, so it cannot continue a saved conversation. Send the history instead.' };
    }
    if (Array.isArray(b.attachments) && b.attachments.length > 0) {
        return { code: INCOGNITO_CODES.attachments, message: 'Files cannot be added to an incognito chat: they would be stored.' };
    }
    if (surface === 'direct' && b.modelTier === 'swarm') {
        return { code: INCOGNITO_CODES.unsupportedMode, message: 'Swarm is not available in an incognito chat.' };
    }
    if (surface === 'agent' && b.test === true) {
        return { code: INCOGNITO_CODES.unsupportedMode, message: 'A test chat cannot be incognito.' };
    }
    return null;
}

/** Throw the 400 for an incognito turn that cannot run. Call it before the stream opens. */
export function assertIncognitoRequest(body: unknown, surface: IncognitoSurface): void {
    const refusal = incognitoRefusal(body, surface);
    if (!refusal) return;
    const { HttpError } = nodeRequire('../http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
    throw new HttpError(400, refusal.code, refusal.message);
}

/**
 * Turn memory off on the request itself: neither read nor write, whatever the
 * client sent (core/memory/memoryPolicy.js reads `memoryReadEnabled: false`
 * as "per-chat memory off"). An agent turn is also made ephemeral, the
 * runtime's no-persistence path. A turn that is not incognito is left alone.
 */
export function applyIncognitoPolicy(body: unknown, surface: IncognitoSurface): void {
    if (!isIncognito(body)) return;
    const b = body as TurnBodyFields;
    b.memoryReadEnabled = false;
    b.memoryWriteEnabled = false;
    if (surface === 'agent') b.ephemeral = true;
}

/** Is this tool kept off an incognito turn? */
export function isIncognitoWithheldTool(name: unknown): boolean {
    return typeof name === 'string' && INCOGNITO_WITHHELD_TOOLS.has(name);
}

interface NamedTool { function?: { name?: string }; name?: string }

/** The offered tools without the ones an incognito turn may not have; the list itself when not incognito. */
export function withholdIncognitoTools<T extends NamedTool>(tools: T[], incognito: boolean | null | undefined): T[] {
    if (incognito !== true || !Array.isArray(tools)) return tools;
    return tools.filter((t) => !isIncognitoWithheldTool(t?.function?.name ?? t?.name));
}

/** The `done` event of an incognito turn: everything but the conversation id. */
export function incognitoDonePayload<T extends object>(payload: T): Omit<T, 'conversationId'> {
    const { conversationId: _dropped, ...rest } = payload as T & { conversationId?: unknown };
    return rest;
}
