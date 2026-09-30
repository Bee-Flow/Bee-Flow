// @mentions in a team chat message: finding the word being typed after an
// `@`, completing it, and working out afterwards who (or which AI) the sent
// text still mentions. Pure functions, no React, no text of their own.

import type { TeamChatRef } from '../../../../api/queries/projectChatTypes';

export type MentionKind = 'user' | 'ai' | 'agent' | 'document' | 'notebook' | 'meeting';

export interface MentionCandidate {
    /** Unique per list: the user id, `ai`, or `agent:<id>`. */
    key: string;
    kind: MentionKind;
    /** What the menu shows. */
    label: string;
    /** What goes into the text after the `@`. */
    token: string;
    userId?: string;
    /** A user's own avatar. */
    picture?: { type: 'emoji' | 'image' | 'url'; value: string };
    /** A tagged document or notebook. */
    ref?: TeamChatRef;
}

export interface MentionQuery {
    /** Index of the `@`. */
    start: number;
    /** What follows the `@` up to the caret. */
    query: string;
}

const QUERY_RX = /(^|\s)@([^\s@]{0,40})$/;
const TRAIL = '(?=$|[\\s.,!?;:)\\]])';

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The mention being typed at the caret, if the caret sits in one. */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
    const m = QUERY_RX.exec(text.slice(0, caret));
    if (!m) return null;
    return { start: caret - m[2].length - 1, query: m[2] };
}

/** Candidates whose name (or any word of it) starts with the query. */
export function matchCandidates(candidates: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
    const q = query.trim().toLowerCase();
    if (!q) return candidates.slice(0, limit);
    return candidates.filter((c) => {
        const label = c.label.toLowerCase();
        return label.startsWith(q) || c.token.toLowerCase().startsWith(q) || label.split(/\s+/).some(w => w.startsWith(q));
    }).slice(0, limit);
}

/** Replace the `@query` at the caret with `@token ` and put the caret after it. */
export function insertMention(text: string, at: MentionQuery, caret: number, token: string): { text: string; caret: number } {
    const inserted = `@${token} `;
    const next = text.slice(0, at.start) + inserted + text.slice(caret).replace(/^ /, '');
    return { text: next, caret: at.start + inserted.length };
}

/** Does the text still carry `@token` as a whole mention? */
export function mentions(text: string, token: string): boolean {
    if (!token) return false;
    return new RegExp(`(^|\\s)@${escapeRx(token)}${TRAIL}`, 'i').test(text);
}

/** From the candidates picked while typing, the ones the final text still names. */
export function resolveMentions(content: string, picked: MentionCandidate[]): { userIds: string[]; refs: TeamChatRef[]; asksAi: boolean } {
    const kept = picked.filter(c => mentions(content, c.token));
    const userIds = [...new Set(kept.filter(c => c.kind === 'user' && c.userId).map(c => c.userId as string))];
    const refs: TeamChatRef[] = [];
    for (const c of kept) {
        if (c.ref && !refs.some(r => r.kind === c.ref!.kind && r.id === c.ref!.id)) refs.push(c.ref);
    }
    return { userIds, refs, asksAi: kept.some(c => c.kind === 'ai' || c.kind === 'agent') };
}

export interface TextPart { text: string; mention: boolean }

/** Split a message so the known `@names` can be painted as mentions. */
export function splitMentions(text: string, tokens: string[]): TextPart[] {
    const usable = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!usable.length || !text.includes('@')) return [{ text, mention: false }];
    const rx = new RegExp(`@(?:${usable.map(escapeRx).join('|')})${TRAIL}`, 'gi');
    const parts: TextPart[] = [];
    let last = 0;
    for (const m of text.matchAll(rx)) {
        const at = m.index ?? 0;
        if (at > 0 && !/\s/.test(text[at - 1])) continue;
        if (at > last) parts.push({ text: text.slice(last, at), mention: false });
        parts.push({ text: m[0], mention: true });
        last = at + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), mention: false });
    return parts;
}
