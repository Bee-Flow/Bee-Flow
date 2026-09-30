/**
 * Delivery, airtime, hand-offs, dead air, monologues, topic ownership and tag
 * mentions — the first half of a port of
 * agent-hub/src/pages/meeting-notes/lib/insightsMetrics.js (model.ts holds
 * the follow-up stats and the model builder), pinned to it by
 * insights.lockstep.test.ts.
 *
 * PRIVACY: a builder whose output names a person says PER-PERSON. Callers go
 * through buildInsightsModel, which never builds those when the organisation
 * switched per-person stats off.
 */

import type { SpeakerTalk } from './talk';
import { fuseSpans, mergeTurns, segmentSpeakerId, type ChapterBlock, type SegmentLike } from './turns';

/** Turns at or above this length count as a monologue. */
const MONOLOGUE_SECONDS = 90;
/** Gaps in the speech union at least this long are listed as dead air. */
const DEAD_AIR_SECONDS = 20;
/** Below this much speech a words-per-minute figure is noise. */
const MIN_WPM_SPEAKING_SECONDS = 30;
/** Hand-off pairs mean nothing until the conversation changed hands this often. */
const MIN_HANDOFF_SWITCHES = 4;

type Segments = readonly SegmentLike[] | null | undefined;

export const normalizeName = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ~12 windows over the meeting, in whole minutes between 1 and 10. */
export function insightsWindowSeconds(durationSeconds: number | null | undefined): number {
    const duration = Number(durationSeconds) || 0;
    if (!duration) return 300;
    const target = Math.round(duration / 12 / 60) * 60;
    return Math.max(60, Math.min(600, target || 60));
}

/** Words in a line: whitespace-split, tokens without a letter or digit dropped. */
export function countWords(text: unknown): number {
    if (typeof text !== 'string' || !text.trim()) return 0;
    return text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export interface SpeakerMetrics {
    words: number;
    wpm: number | null;
    questionCount: number;
    avgTurnSeconds: number;
    listeningSeconds: number;
}

/** Words and question lines per speaker, from the segments' text. */
function countsBySpeaker(segments: Segments): { words: Map<string, number>; questions: Map<string, number> } {
    const words = new Map<string, number>();
    const questions = new Map<string, number>();
    for (const seg of segments || []) {
        if (!seg || typeof seg.text !== 'string') continue;
        const id = segmentSpeakerId(seg);
        words.set(id, (words.get(id) || 0) + countWords(seg.text));
        if (seg.text.includes('?')) questions.set(id, (questions.get(id) || 0) + 1);
    }
    return { words, questions };
}

/** Pace, turn shape, questions and listening time per speaker. PER-PERSON. */
export function buildSpeakerMetrics(
    segments: Segments,
    talkSpeakers: readonly Pick<SpeakerTalk, 'speakerId' | 'speakingSeconds' | 'turnCount'>[],
    durationSeconds: number | null | undefined,
): Map<string, SpeakerMetrics> {
    const duration = Number(durationSeconds) || 0;
    const { words, questions } = countsBySpeaker(segments);
    const out = new Map<string, SpeakerMetrics>();
    for (const s of talkSpeakers || []) {
        const spoken = Number(s.speakingSeconds) || 0;
        const w = words.get(s.speakerId) || 0;
        out.set(s.speakerId, {
            words: w,
            wpm: spoken >= MIN_WPM_SPEAKING_SECONDS ? Math.round(w / (spoken / 60)) : null,
            questionCount: questions.get(s.speakerId) || 0,
            avgTurnSeconds: s.turnCount > 0 ? Math.round(spoken / s.turnCount) : 0,
            listeningSeconds: Math.max(0, Math.round(duration - spoken)),
        });
    }
    return out;
}

/**
 * Invited people who never got a turn. PER-PERSON. Anything ambiguous counts
 * as present: wrongly telling someone they said nothing is worse.
 */
export function buildSilentAttendees(
    attendees: readonly unknown[] | null | undefined,
    talkSpeakers: readonly { speakerId: string }[] | null | undefined,
): string[] {
    const list = (Array.isArray(attendees) ? attendees : []).map((a) => String(a || '').trim()).filter(Boolean);
    if (!list.length) return [];
    const ids = (talkSpeakers || []).map((s) => normalizeName(s.speakerId)).filter(Boolean);
    if (!ids.length) return list;
    return list.filter((name) => {
        const norm = normalizeName(name);
        if (!norm) return false;
        if (ids.some((id) => id === norm)) return false;
        const first = norm.split(' ')[0] ?? '';
        if (first.length < 2) return false;
        return !ids.some((id) => id.split(' ')[0] === first);
    });
}

export interface AirtimeWindow {
    start: number;
    end: number;
    speechSeconds: number;
    shares: { speakerId: string; seconds: number; share: number }[];
}

/** Each window's speech, shared out per speaker: who held the floor when. PER-PERSON. */
export function buildAirtimeWindows(
    segments: Segments,
    durationSeconds: number | null | undefined,
    { windowSeconds }: { windowSeconds?: number } = {},
): AirtimeWindow[] {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || !turns.length) return [];
    const size = windowSeconds || insightsWindowSeconds(duration);
    const windows: { start: number; end: number; byId: Map<string, number> }[] = [];
    for (let start = 0; start < duration; start += size) {
        windows.push({ start, end: Math.min(duration, start + size), byId: new Map() });
    }
    if (!windows.length) return [];
    for (const turn of turns) {
        const from = Math.max(0, Math.min(turn.start, duration));
        const to = Math.max(0, Math.min(turn.end, duration));
        if (to <= from) continue;
        for (let i = Math.min(windows.length - 1, Math.floor(from / size)); i < windows.length; i++) {
            const w = windows[i] as (typeof windows)[number];
            if (w.start >= to) break;
            const overlap = Math.min(to, w.end) - Math.max(from, w.start);
            if (overlap > 0) w.byId.set(turn.speakerId, (w.byId.get(turn.speakerId) || 0) + overlap);
        }
    }
    return windows.map((w) => {
        const total = Array.from(w.byId.values()).reduce((acc, v) => acc + v, 0);
        const shares = Array.from(w.byId.entries())
            .map(([speakerId, seconds]) => ({ speakerId, seconds: Math.round(seconds), share: total > 0 ? seconds / total : 0 }))
            .sort((a, b) => b.seconds - a.seconds);
        return { start: w.start, end: w.end, speechSeconds: Math.round(total), shares };
    });
}

export interface Handoff {
    from: string;
    to: string;
    count: number;
}

/** Who tends to speak right after whom. PER-PERSON. [] below four switches. */
export function buildHandoffPairs(segments: Segments, { limit = 5 }: { limit?: number } = {}): Handoff[] {
    const turns = mergeTurns(segments);
    if (turns.length < 2) return [];
    // Nested, not a joined key: the ids are display names with spaces in them.
    const counts = new Map<string, Map<string, number>>();
    let switches = 0;
    for (let i = 1; i < turns.length; i++) {
        const from = turns[i - 1]?.speakerId as string;
        const to = turns[i]?.speakerId as string;
        if (from === to) continue;
        switches += 1;
        const inner = counts.get(from) ?? new Map<string, number>();
        inner.set(to, (inner.get(to) || 0) + 1);
        counts.set(from, inner);
    }
    if (switches < MIN_HANDOFF_SWITCHES) return [];
    const pairs: Handoff[] = [];
    for (const [from, inner] of counts) for (const [to, count] of inner) pairs.push({ from, to, count });
    return pairs.sort((a, b) => b.count - a.count).slice(0, limit);
}

export interface DeadAir {
    start: number;
    end: number;
    seconds: number;
    kind: 'lead_in' | 'gap' | 'lead_out';
}

/** Stretches where nobody spoke, longest first; lead-in and lead-out tagged as such. */
export function buildDeadAir(
    segments: Segments,
    durationSeconds: number | null | undefined,
    { minSeconds = DEAD_AIR_SECONDS, limit = 5 }: { minSeconds?: number; limit?: number } = {},
): DeadAir[] {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || !turns.length) return [];
    const union = fuseSpans(
        turns
            .map((t) => ({ start: Math.max(0, t.start), end: Math.min(t.end, duration) }))
            .filter((s) => s.end > s.start)
            .sort((a, b) => a.start - b.start),
    );
    const first = union[0];
    const last = union[union.length - 1];
    if (!first || !last) return [];
    const gaps: Omit<DeadAir, 'seconds'>[] = [];
    if (first.start >= minSeconds) gaps.push({ start: 0, end: first.start, kind: 'lead_in' });
    for (let i = 1; i < union.length; i++) {
        const prev = union[i - 1] as (typeof union)[number];
        const next = union[i] as (typeof union)[number];
        if (next.start - prev.end >= minSeconds) gaps.push({ start: prev.end, end: next.start, kind: 'gap' });
    }
    if (duration - last.end >= minSeconds) gaps.push({ start: last.end, end: duration, kind: 'lead_out' });
    return gaps
        .map((g) => ({ ...g, start: Math.round(g.start), end: Math.round(g.end), seconds: Math.round(g.end - g.start) }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, limit);
}

export interface MonologueRatio {
    seconds: number;
    totalSeconds: number;
    ratio: number;
    count: number;
}

/** How much of the speaking went into long uninterrupted stretches. Names nobody. */
export function buildMonologueRatio(segments: Segments): MonologueRatio | null {
    const turns = mergeTurns(segments);
    if (!turns.length) return null;
    let total = 0;
    let mono = 0;
    let count = 0;
    for (const t of turns) {
        const len = t.end - t.start;
        if (len <= 0) continue;
        total += len;
        if (len >= MONOLOGUE_SECONDS) {
            mono += len;
            count += 1;
        }
    }
    if (total <= 0) return null;
    return { seconds: Math.round(mono), totalSeconds: Math.round(total), ratio: mono / total, count };
}

export interface TopicBlock extends ChapterBlock {
    topSpeakerId?: string | null;
    topSpeakerShare?: number;
    openedBy?: string | null;
}

/** Per chapter: who spoke most in it and who opened it (PER-PERSON fields). */
export function buildTopicOwnership(segments: Segments, chapters: readonly ChapterBlock[] | null | undefined): TopicBlock[] {
    const blocks = Array.isArray(chapters) ? chapters : [];
    if (!blocks.length) return [];
    const turns = mergeTurns(segments);
    return blocks.map((block) => {
        const byId = new Map<string, number>();
        let opener: string | null = null;
        let openerStart = Infinity;
        for (const turn of turns) {
            const overlap = Math.min(turn.end, block.endSeconds) - Math.max(turn.start, block.seconds);
            if (overlap <= 0) continue;
            byId.set(turn.speakerId, (byId.get(turn.speakerId) || 0) + overlap);
            if (turn.start < openerStart) {
                openerStart = turn.start;
                opener = turn.speakerId;
            }
        }
        const total = Array.from(byId.values()).reduce((acc, v) => acc + v, 0);
        let topSpeakerId: string | null = null;
        let topSeconds = 0;
        for (const [id, secs] of byId.entries()) {
            if (secs > topSeconds) {
                topSeconds = secs;
                topSpeakerId = id;
            }
        }
        return { ...block, topSpeakerId, topSpeakerShare: total > 0 ? topSeconds / total : 0, openedBy: opener };
    });
}

export interface TagMention {
    tag: string;
    count: number;
    firstSeconds: number | null;
}

/** How often each tag is actually said, and where it first came up. */
export function buildTagMentions(tags: readonly unknown[] | null | undefined, segments: Segments): TagMention[] {
    const list = (Array.isArray(tags) ? tags : []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!list.length || !Array.isArray(segments)) return [];
    const patterns = list.map((tag) => ({
        tag,
        re: new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(tag).replace(/\\?\s+/g, '\\s+')})(?=[^\\p{L}\\p{N}]|$)`, 'giu'),
        count: 0,
        firstSeconds: null as number | null,
    }));
    for (const seg of segments) {
        if (!seg || typeof seg.text !== 'string' || !seg.text) continue;
        const seconds = Number(seg.start);
        for (const p of patterns) {
            p.re.lastIndex = 0;
            const hits = seg.text.match(p.re);
            if (!hits) continue;
            p.count += hits.length;
            if (p.firstSeconds === null && Number.isFinite(seconds)) p.firstSeconds = Math.max(0, Math.round(seconds));
        }
    }
    return patterns
        .filter((p) => p.count > 0)
        .map(({ tag, count, firstSeconds }) => ({ tag, count, firstSeconds }))
        .sort((a, b) => b.count - a.count);
}
