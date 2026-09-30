/**
 * The model's reasoning as the panel shows it: the parts, how long they took
 * and what the header says — the pure half of the web's ThinkingPanel.jsx
 * (resolveParts, computeDurationMs, formatDuration; pinned by
 * thinking.lockstep.test.ts).
 */

import type { ChatMessage, ThinkingPart } from './types';

/** The parts: live or reloaded, or one legacy block wrapped as a part. */
export function thinkingPartsOf(message: Pick<ChatMessage, 'thinkingParts' | 'thinking'>): ThinkingPart[] {
    if (message.thinkingParts?.length) return message.thinkingParts;
    if (message.thinking) return [{ id: 'legacy-0', text: message.thinking, startedAt: null, endedAt: null }];
    return [];
}

/** First start to last end; null when the parts carry no timing (legacy, redacted-only). */
export function thinkingDurationMs(parts: readonly ThinkingPart[]): number | null {
    const starts = parts.map((p) => p.startedAt).filter((t): t is number => Boolean(t));
    const ends = parts.map((p) => p.endedAt).filter((t): t is number => Boolean(t));
    if (starts.length === 0 || ends.length === 0) return null;
    return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/** "3.4s", "12s", "2m 5s". */
export function formatThinkingDuration(ms: number | null): string {
    if (ms == null) return '';
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
}

/** Something to show: a part with text, or a part the provider redacted. */
export function hasThinking(parts: readonly ThinkingPart[]): boolean {
    return parts.length > 0 && parts.some((p) => p.text || p.redacted);
}

/** When the model started thinking, for the live clock: the first part that says. */
export function thinkingStart(parts: readonly ThinkingPart[]): number | null {
    return parts.find((p) => p.startedAt)?.startedAt ?? null;
}

/** Whether a part is still being written. */
export function thinkingLive(streaming: boolean | undefined, parts: readonly ThinkingPart[]): boolean {
    return Boolean(streaming) && parts.some((p) => !p.endedAt);
}
