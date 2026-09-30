/**
 * Where a turn's parts land on a message: the live turn drawn into the
 * streaming cell, and the finished turn written into its placeholder, go
 * through the same mapping — so an answer that finishes is the same bubble
 * with the same parts, not a different one.
 */

import type { AnswerParts, TurnBlock } from '@/shared/stream';

import type { ChatMessage } from './types';

/** A turn as far as an answer cares: its words and whichever parts its surface has. */
export type TurnAnswer = Partial<AnswerParts> & { text: string };

const some = <T>(list: readonly T[] | undefined): T[] | undefined => (list && list.length ? [...list] : undefined);

/** The answer's parts, dropping the empty ones so a plain answer stays a plain message. */
export function answerFields(turn: TurnAnswer): Partial<ChatMessage> {
    const drafts = turn.drafts && Object.values(turn.drafts).some((list) => list.length) ? turn.drafts : undefined;
    return {
        thinking: turn.thinking || undefined,
        thinkingParts: some(turn.thinkingParts),
        phaseTrail: some(turn.phaseTrail),
        currentPhase: turn.currentPhase ?? undefined,
        tools: some(turn.tools),
        sources: some(turn.sources),
        images: some(turn.images),
        audio: some(turn.audio),
        video: some(turn.video),
        files: some(turn.files),
        maps: some(turn.maps),
        drafts,
        pendingToolCalls: some(turn.pendingToolCalls),
        tokenisation: turn.tokenisation ?? undefined,
        ruleAttribution: some(turn.ruleAttribution ?? undefined),
        modelId: turn.modelId ?? undefined,
        modelTier: turn.modelTier ?? undefined,
        autoSelectedTier: turn.autoSelectedTier ?? undefined,
    };
}

/** The streaming placeholder with the live turn drawn into it. */
export function liveMessage(message: ChatMessage, turn: TurnAnswer | undefined): ChatMessage {
    if (!turn) return message;
    return { ...message, content: turn.text, ...answerFields(turn) };
}

/**
 * Whether a message carries anything the "How I got this answer" panel can
 * say (the web's gate in MessageItem): reasoning, tools, the model or tier,
 * sources, privacy — or the phase trail, which is this app's addition to it.
 */
export function hasAnswerTrace(message: ChatMessage): boolean {
    return Boolean(
        message.thinking ||
            message.tools?.length ||
            message.autoSelectedTier ||
            message.modelId ||
            message.sources?.length ||
            message.phaseTrail?.length ||
            hasPrivacyInfo(message),
    );
}

/**
 * The tokenisation info has something the privacy sheet can show: a count, the
 * opt-in raw payload, or a scan that did not cover the whole upload (BFSF-291:
 * "raw payload on, nothing found" still deserves the confirmation).
 */
export function hasPrivacyInfo(message: ChatMessage): boolean {
    const t = message.tokenisation;
    return Boolean(
        (t?.count ?? 0) > 0 ||
            t?.tokenizedPrompt ||
            t?.rawResponse ||
            t?.tokenMap ||
            t?.attachments?.some((a) => a.timeout || a.overflow || a.reason),
    );
}

/**
 * A turn that ended with nothing to show and nothing reported was cut off —
 * by the person, or by the phone leaving the network. A turn whose work is a
 * card (a draft, a file, a held action, an image) without prose is not one.
 */
export function producedNothing(turn: TurnAnswer & { error?: string | null }): boolean {
    if (turn.error || turn.text) return false;
    const fields = answerFields(turn);
    return !(fields.drafts || fields.files || fields.images || fields.audio || fields.video || fields.pendingToolCalls || fields.maps);
}

/**
 * A direct-chat turn the server never finished: the person pressed Stop, or
 * the socket closed before `done` — with or without words by then. Both are
 * drawn as "stopped early" and kept until the server's copy has the turn. An
 * error is not one: it has its own card. Nor is a refusal (the shield, a
 * guardrail, a locked history): its notice says why, and the refetch takes
 * the question away as it always did — a stopped one would keep it, and offer
 * to send it again.
 */
export function endedEarly(turn: TurnAnswer & { error: string | null; completed: boolean; blocked?: TurnBlock | null }): boolean {
    if (turn.error || turn.blocked) return false;
    return !turn.completed || producedNothing(turn);
}

const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * The text the answer renders. With images in the turn their markdown is
 * dropped, as the web drops it (MessageContentBody.jsx): the pictures render
 * from the stored files below, and an inline copy is a data URL at best.
 */
export function answerText(message: Pick<ChatMessage, 'content' | 'images'>): string {
    return message.images?.length ? message.content.replace(IMAGE_MARKDOWN, '').trim() : message.content;
}

/**
 * An answer as plain text, for "Copy": what a paste into a messenger or a
 * mail should read as — the words without the markdown's marks. "Copy as
 * Markdown" keeps the source.
 */
export function plainTextOf(markdown: string): string {
    return markdown
        .replace(/```[^\n]*\n?/g, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/^>\s?/gm, '')
        .trim();
}
