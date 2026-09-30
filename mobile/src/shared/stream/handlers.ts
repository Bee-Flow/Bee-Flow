/**
 * The building blocks the surface adapters are made of.
 *
 * Each handler is typed with the smallest slice of turn it touches, so any
 * surface whose turn has that slice can list it. Where two surfaces genuinely
 * differ (whether `content_replace` may blank the answer, which fields a
 * `thinking` frame reads), there are two handlers with names that say how —
 * the difference is a decision each adapter makes visibly, not a drift.
 *
 * Event names and payload fields come from server/routes/ai/directChat/
 * streamTurn.js, server/core/agentRuntime/** and the switch in
 * agent-hub/src/hooks/useChatEngine/sseEvents.ts.
 */

import { translate } from '@/core/i18n';

import type { FrameData, FrameHandler } from './chatFrameReducer';
import { toKbSources } from './kbSources';
import type { DlpDecision, DlpFinding, KbSource, ToolActivity, TurnBlock, TurnImage } from './types';

export function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** A frame's `reason`, else its `message`, else nothing. */
export function reasonOf(d: FrameData): string | undefined {
    return str(d.reason) || str(d.message) || undefined;
}

// ── The answer itself ────────────────────────────────────────────────────

export const appendText: FrameHandler<{ text: string }> = (turn, d) => {
    turn.text += str(d.text);
};

/**
 * The privacy shield rewrites text already sent: `content_replace` swaps the
 * whole answer, `content_redact` removes a span. Both REPLACE — appending
 * shows the unredacted text and then shows it again. This one takes the
 * payload as-is, even empty.
 */
export const replaceText: FrameHandler<{ text: string }> = (turn, d) => {
    turn.text = str(d.text);
};

/** As replaceText, but an empty payload keeps what is on screen. */
export const replaceTextUnlessEmpty: FrameHandler<{ text: string }> = (turn, d) => {
    turn.text = str(d.text) || turn.text;
};

// ── Reasoning ────────────────────────────────────────────────────────────

interface Thinking {
    thinking: string;
    thinkingActive: boolean;
}

/** Direct chat and agents send the delta as `text` or, on some paths, `thinking`. */
export const appendThinking: FrameHandler<Thinking> = (turn, d) => {
    turn.thinking += str(d.text) || str(d.thinking);
    turn.thinkingActive = true;
};

/** The notebook/template runtimes only ever send `text`. */
export const appendThinkingText: FrameHandler<Thinking> = (turn, d) => {
    turn.thinking += str(d.text);
    turn.thinkingActive = true;
};

export const thinkingStarted: FrameHandler<Thinking> = (turn) => {
    turn.thinkingActive = true;
};

export const thinkingStopped: FrameHandler<Thinking> = (turn) => {
    turn.thinkingActive = false;
};

// ── Progress ─────────────────────────────────────────────────────────────

/** Direct chat's `{ phase }` (some paths say `name`). */
export const phaseByName: FrameHandler<{ phase: string | null }> = (turn, d) => {
    turn.phase = str(d.phase) || str(d.name) || null;
};

export const modelSelected: FrameHandler<{ modelId: string | null }> = (turn, d) => {
    turn.modelId = str(d.modelId) || null;
};

export const titled: FrameHandler<{ title: string | null }> = (turn, d) => {
    turn.title = str(d.title) || turn.title;
};

/**
 * The server creates the row mid-stream on a brand-new chat. Catching it here
 * (rather than waiting for `done`) means the screen has an id to navigate
 * with, and to reload from, before the answer finishes.
 */
export const conversationCreated: FrameHandler<{ conversationId: string | null }> = (turn, d) => {
    turn.conversationId = str(d.conversationId) || turn.conversationId;
};

// ── Tools ────────────────────────────────────────────────────────────────

/** A plain object, or nothing: `args` and `preview` are records or they are absent. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A saved turn keeps the first 120 characters of a result (the web's toolHistory). */
export const RESULT_PREVIEW_MAX = 120;

export function resultPreview(result: unknown): string {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '') ?? '';
    return text.slice(0, RESULT_PREVIEW_MAX);
}

/**
 * A call started: `{ name, args }` from both runtimes (directChat/toolExec.js,
 * agentRuntime/toolRoundExecutor.js), timed here the way the web stamps
 * `startTime`. There is no call id on the wire, so the position stands in.
 */
export const toolStarted: FrameHandler<{ tools: ToolActivity[] }> = (turn, d) => {
    const name = str(d.name) || 'Tool';
    const tool: ToolActivity = {
        id: str(d.id) || `${name}-${turn.tools.length}`,
        name,
        status: 'running',
        detail: str(d.label) || str(d.summary) || undefined,
        args: recordOf(d.args),
        startTime: Date.now(),
    };
    turn.tools = [...turn.tools, tool];
};

/**
 * A call ended: `{ name, result }`. It closes the call with that id, else the
 * FIRST still-running call of that name — the web closes every running call
 * of the name at once, which dates a parallel twin's end too early.
 */
export const toolEnded: FrameHandler<{ tools: ToolActivity[] }> = (turn, d) => {
    const id = str(d.id);
    const name = str(d.name);
    const at = turn.tools.findIndex((t) => (id ? t.id === id || t.name === id : t.name === name && t.status === 'running'));
    if (at < 0) return false;
    const tool = turn.tools[at] as ToolActivity;
    const next = turn.tools.slice();
    next[at] = {
        ...tool,
        status: d.error ? 'error' : 'done',
        detail: str(d.summary) || tool.detail,
        endTime: Date.now(),
        ...(d.result !== undefined ? { result: d.result, resultPreview: resultPreview(d.result) } : {}),
    };
    turn.tools = next;
};

// ── Citations and media ──────────────────────────────────────────────────

/**
 * The citation shape from core/kb/citation.js. KbSource calls the body
 * `snippet`, so it is mapped rather than cast — in ONE place, kbSources.ts.
 */
export const kbSources: FrameHandler<{ sources: KbSource[] }> = (turn, d) => {
    turn.sources = toKbSources(d.sources);
};

export const imageAdded: FrameHandler<{ images: TurnImage[] }> = (turn, d) => {
    const image = { data: str(d.data), mimeType: str(d.mimeType) || 'image/png' };
    if (image.data) turn.images = [...turn.images, image];
};

// ── Questions and refusals ───────────────────────────────────────────────

function readFinding(raw: unknown, index: number): DlpFinding {
    const f = recordOf(raw) ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
    return {
        id: str(f.id) || `finding_${index}`,
        label: str(f.label) || undefined,
        category: str(f.category) || undefined,
        source: str(f.source) || undefined,
        confidenceBand: str(f.confidenceBand) || null,
        offset: num(f.offset),
        length: num(f.length),
        text: str(f.text) || undefined,
    };
}

/** The `dlp_preview` / `dlp_attachment_preview` payload (core/dlp/dlpPreflight.js, attachmentAskFlow.js). */
export function readDlpDecision(d: FrameData, kind: DlpDecision['kind']): DlpDecision | null {
    const decisionId = str(d.decisionId) || str(d.id);
    if (!decisionId) return null;
    const provider = recordOf(d.provider);
    return {
        decisionId,
        summary: str(d.summary) || str(d.message) || 'Bee Flow found personal data in what you are about to send.',
        kind,
        reviewText: typeof d.reviewText === 'string' ? d.reviewText : undefined,
        filename: str(d.filename) || undefined,
        findings: Array.isArray(d.findings) ? d.findings.map(readFinding) : [],
        provider: provider
            ? { displayName: str(provider.displayName) || undefined, isExternal: provider.isExternal !== false }
            : undefined,
    };
}

/**
 * NOT a refusal — a QUESTION. The server has stopped mid-turn and holds the
 * stream open until the app answers on /api/chat/dlp-decision. Ignoring it is
 * an apparent hang with no error at all.
 */
export const dlpPreview: FrameHandler<{ dlpDecision: DlpDecision | null }> = (turn, d) => {
    const decision = readDlpDecision(d, 'chat_text');
    if (!decision) return false;
    turn.dlpDecision = decision;
};

/** The same pause, for one attachment at a time (attachmentAskFlow.js: sequential, not batched). */
export const dlpAttachmentPreview: FrameHandler<{ dlpDecision: DlpDecision | null }> = (turn, d) => {
    const decision = readDlpDecision(d, 'attachment');
    if (!decision) return false;
    turn.dlpDecision = decision;
};

export const dlpResolved: FrameHandler<{ dlpDecision: DlpDecision | null }> = (turn) => {
    turn.dlpDecision = null;
};

/**
 * A refusal: the server decided, correctly, not to send something onward. It
 * gets its own UI, not a red banner — so it is `blocked`, not `error`.
 */
export function blockedBy(
    reason: string,
    detail: (d: FrameData) => string | undefined = reasonOf,
): FrameHandler<{ blocked: TurnBlock | null }> {
    return (turn, d) => {
        turn.blocked = { reason, detail: detail(d) };
    };
}

/** As blockedBy, for a refusal whose payload says nothing more. */
export function blockedWith(block: TurnBlock): FrameHandler<{ blocked: TurnBlock | null }> {
    return (turn) => {
        turn.blocked = { ...block };
    };
}

export const DLP_BLOCKED_REASON = 'Data-loss prevention stopped this message.';
export const GUARDRAIL_REASON = 'A guardrail stopped this response.';

/**
 * The question is gone: nothing the person answers can reach the server any
 * more. decisionQueue.js holds a decision for about 60 seconds and forgets it
 * once the turn moves on, answering every later reply with a 404 — so a
 * review left up past that point traps the person in a full-screen sheet
 * whose every button fails.
 */
export function dropDlpQuestion(turn: { dlpDecision?: DlpDecision | null }): void {
    if (turn.dlpDecision) turn.dlpDecision = null;
}

/**
 * What the ask flow's own refusals mean (dlpPreflight.js), in the web's
 * words (sseEvents.ts's dlp_blocked). Any other code keeps the frame's words.
 */
const ASK_OUTCOMES: Readonly<Record<string, readonly [key: string, en: string]>> = {
    timeout: ['dlp.blocked_timeout', 'Blocked: DLP decision timed out.'],
    user_blocked: ['dlp.blocked_user', 'Prompt blocked by you.'],
};

function dlpBlockDetail(d: FrameData): string | undefined {
    const outcome = ASK_OUTCOMES[str(d.reason)];
    return outcome ? translate(outcome[0], outcome[1]) : reasonOf(d);
}

const blockedByDlp = blockedBy(DLP_BLOCKED_REASON, dlpBlockDetail);

/**
 * The DLP refusal on a surface that can also ASK. The stop settles any
 * question still up: the person chose Block, or the hold ran out (`timeout`)
 * while the review was still waiting for them.
 */
export const dlpBlocked: FrameHandler<{ blocked: TurnBlock | null; dlpDecision: DlpDecision | null }> = (turn, d) => {
    dropDlpQuestion(turn);
    blockedByDlp(turn, d);
};

// ── Terminal ─────────────────────────────────────────────────────────────

export const failed: FrameHandler<{ error: string | null; done: boolean }> = (turn, d) => {
    turn.error = str(d.error) || 'The server reported an error.';
    turn.done = true;
};
