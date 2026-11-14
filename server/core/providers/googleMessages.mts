/**
 * The Google adapter's message conversion (GoogleProvider.normalizeMessages
 * in ./google.js, inherited by Vertex): an OpenAI-shaped history becomes the
 * GenAI `contents` plus one `systemInstruction`.
 *
 * Gemini's rules shape it: system messages fold into one instruction, a tool
 * result is a `functionResponse` part in a user turn and must name the
 * function it answers, empty turns are rejected, and so are two consecutive
 * turns of the same role. While converting, a function-call part carries the
 * internal `_toolCallId` of the call it came from so a later tool result can
 * find its function name; the marker is removed before the contents leave.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../../utils/bestEffort') as { fallback(where: string, err: unknown): void };

type Part = {
    text?: string;
    functionCall?: { name?: string; args?: unknown };
    functionResponse?: { name?: string; response: unknown };
    inlineData?: { mimeType: string; data: string };
    fileData?: { fileUri: string; mimeType: string };
    thoughtSignature?: string;
    _toolCallId?: string;
    [k: string]: unknown;
};

export type Content = { role: string; parts: Part[] };

type ToolCall = {
    id?: string;
    name?: string;
    function?: { name?: string; arguments?: string };
    _thought_signature?: string;
    _raw_content_parts?: unknown[];
};

type ImageRef = string | { url?: string; mimeType?: string } | undefined;
type InPart = { type?: string; text?: string; image_url?: ImageRef };

export type InMessage = {
    role?: string;
    content?: unknown;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
};

export function normalizeGoogleMessages(messages: InMessage[]): { systemInstruction: string | null; contents: Content[] } {
    let systemInstruction: string | null = null;
    const contents: Content[] = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = systemText(msg.content);
            systemInstruction = systemInstruction ? `${systemInstruction}\n\n${text}` : text;
            continue;
        }
        const entry = contentFor(msg, contents);
        if (entry) contents.push(entry);
    }
    stripToolCallIds(contents);
    return { systemInstruction, contents: mergeSameRole(contents) };
}

function systemText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text || '').join('\n');
    return JSON.stringify(content);
}

/** The turn one non-system message becomes, or null when it has nothing Gemini accepts. */
function contentFor(msg: InMessage, earlier: Content[]): Content | null {
    if (msg.role === 'tool') return toolResultContent(msg, earlier);
    if (msg.role === 'assistant') return assistantContent(msg);
    return userContent(msg);
}

// ─── Tool results ────────────────────────────────────────────

/** Google expects a tool result as a functionResponse part in a user turn. */
function toolResultContent(msg: InMessage, earlier: Content[]): Content {
    const name = msg.tool_call_id ? functionNameOf(msg.tool_call_id, msg.name || 'unknown', earlier) : (msg.name || 'unknown');
    return { role: 'user', parts: [{ functionResponse: { name, response: toolResponse(msg.content) } }] };
}

/**
 * The function name of the call `toolCallId` answers. Every earlier model
 * turn is searched; the oldest turn that holds the id wins (the first match
 * inside that turn), and without a match the message's own name stands.
 */
function functionNameOf(toolCallId: string, ownName: string, earlier: Content[]): string {
    let name = ownName;
    for (let i = earlier.length - 1; i >= 0; i--) {
        const hit = callIn(earlier[i], toolCallId);
        if (hit) name = hit.name as string;
    }
    return name;
}

function callIn(content: Content, toolCallId: string): { name: string | undefined } | null {
    if (content.role !== 'model' || !content.parts) return null;
    for (const part of content.parts) {
        if (part.functionCall && part._toolCallId === toolCallId) return { name: part.functionCall.name };
    }
    return null;
}

/**
 * `response` is a protobuf Struct: an array, number, boolean or null ("[]",
 * "42") is a 400 for the whole request, so anything but an object is wrapped,
 * and so is text that is not JSON.
 */
function toolResponse(content: unknown): unknown {
    let data: unknown;
    try {
        data = JSON.parse(content as string);
    } catch {
        data = { result: content };
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) data = { result: data };
    return data;
}

// ─── Assistant turns ─────────────────────────────────────────

function assistantContent(msg: InMessage): Content | null {
    const rawParts = msg.tool_calls?.[0]?._raw_content_parts;
    if (Array.isArray(rawParts) && rawParts.length > 0) return { role: 'model', parts: replayedParts(rawParts, msg.tool_calls as ToolCall[]) };
    const parts: Part[] = [];
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) parts.push({ text: msg.content });
    const calls = msg.tool_calls;
    if (calls && calls.length > 0) for (const tc of calls) parts.push(functionCallPart(tc));
    return parts.length > 0 ? { role: 'model', parts } : null;
}

/**
 * Gemini 3.x: when the previous response captured its raw SDK parts on the
 * first tool call, they are replayed verbatim. That keeps thought parts and
 * signatures exactly as received, which multi-turn tool calling requires;
 * only the internal _toolCallId marker is re-attached, the n-th function
 * call getting the n-th tool call's id.
 */
function replayedParts(rawParts: unknown[], toolCalls: ToolCall[]): Part[] {
    let fcIdx = 0;
    return rawParts.map((p) => {
        if (!p || typeof p !== 'object') return p as Part;
        const clone: Part = { ...(p as Part) };
        if (clone.functionCall) {
            const tc = toolCalls[fcIdx++];
            if (tc?.id) clone._toolCallId = tc.id;
        }
        return clone;
    });
}

/** An OpenAI tool call as a functionCall part; arguments that are not JSON go as {}. */
function functionCallPart(tc: ToolCall): Part {
    let args = {};
    try {
        args = JSON.parse(tc.function?.arguments || '{}');
    } catch (e) {
        fallback('core/providers/google:GoogleProvider.normalizeMessages', e);
    }
    const part: Part = { functionCall: { name: tc.function?.name || tc.name, args } };
    // Gemini 3.x requires the thoughtSignature it sent with the call back.
    if (tc._thought_signature) part.thoughtSignature = tc._thought_signature;
    part._toolCallId = tc.id;
    return part;
}

// ─── User turns ──────────────────────────────────────────────

/** Any other role is a user turn. Gemini rejects an empty one, so it is left out. */
function userContent(msg: InMessage): Content | null {
    if (typeof msg.content === 'string') return msg.content.trim() ? { role: 'user', parts: [{ text: msg.content }] } : null;
    if (!Array.isArray(msg.content)) return null;
    const parts = (msg.content as InPart[]).map(userPart).filter((p): p is Part => p !== null);
    return parts.length > 0 ? { role: 'user', parts } : null;
}

function userPart(part: InPart): Part | null {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image_url') return imagePart(part.image_url);
    return null;
}

/** A data URL becomes inlineData; an http(s) URL becomes fileData, which Gemini fetches itself. */
function imagePart(image: ImageRef): Part | null {
    const url = typeof image === 'string' ? image : (image?.url || '');
    if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
    }
    if (url.startsWith('http')) {
        return { fileData: { fileUri: url, mimeType: (typeof image === 'object' && image?.mimeType) || 'image/png' } };
    }
    return null;
}

// ─── Finishing ───────────────────────────────────────────────

function stripToolCallIds(contents: Content[]): void {
    for (const content of contents) {
        if (!content.parts) continue;
        for (const part of content.parts) delete part._toolCallId;
    }
}

/** Consecutive turns of the same role become one: Gemini rejects them. */
function mergeSameRole(contents: Content[]): Content[] {
    const merged: Content[] = [];
    for (const entry of contents) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === entry.role) prev.parts = [...prev.parts, ...entry.parts];
        else merged.push({ ...entry, parts: [...entry.parts] });
    }
    return merged;
}
