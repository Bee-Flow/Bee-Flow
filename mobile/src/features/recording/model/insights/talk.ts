/**
 * Talk time, balance, interactivity and the viewer's own row — a port of
 * agent-hub/src/pages/meeting-notes/lib/insightsData.js (all but
 * findNameMentions, which the phone does not show), pinned to it by
 * insights.lockstep.test.ts. Pure: everything comes from the detail payload.
 */

import { fuseSpans, mergeTurns, type SegmentLike, type Span } from './turns';

/** Turns at least this long are flagged as a monologue. */
const MONOLOGUE_FLAG_SECONDS = 90;

/** Speaker changes per minute that count as a fully interactive dialogue (score 10). */
const SWITCHES_PER_MINUTE_LIVELY = 3;

export interface RosterLike {
    id: string;
    speakingSeconds?: number;
    summary?: string;
}

export interface Monologue {
    start: number;
    end: number;
    seconds: number;
    flagged: boolean;
}

export interface SpeakerTalk {
    speakerId: string;
    speakingSeconds: number;
    share: number;
    turnCount: number;
    summary?: string;
    longestMonologue: Monologue | null;
}

export interface TalkStats {
    speakers: SpeakerTalk[];
    totalSpeakingSeconds: number;
    silenceSeconds: number;
    topShare: number;
    balance: number;
}

function longestOf(fused: readonly Span[]): Monologue | null {
    let best: Span | null = null;
    for (const s of fused) if (s.end - s.start > (best ? best.end - best.start : 0)) best = s;
    if (!best) return null;
    const seconds = Math.round(best.end - best.start);
    return { start: best.start, end: best.end, seconds, flagged: seconds >= MONOLOGUE_FLAG_SECONDS };
}

/** Normalised Shannon entropy of the shares: 1 even, 0 one voice; 1 for a solo recording. */
function balanceScore(shares: readonly number[]): number {
    const active = shares.filter((p) => p > 0);
    if (active.length <= 1) return 1;
    const entropy = -active.reduce((acc, p) => acc + p * Math.log(p), 0);
    return entropy / Math.log(active.length);
}

/**
 * Per-speaker talk statistics plus the meeting-level balance numbers.
 * Speaking seconds prefer the roster's `speakingSeconds` (what the speaker
 * chips show) and fall back to the summed turns for someone not on it.
 */
export function buildTalkStats(
    segments: readonly SegmentLike[] | null | undefined,
    speakers: readonly RosterLike[] | null | undefined,
    durationSeconds: number | null | undefined,
): TalkStats | null {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || !turns.length) return null;

    const spansById = new Map<string, Span[]>();
    for (const t of turns) {
        const list = spansById.get(t.speakerId) ?? [];
        list.push({ start: t.start, end: t.end });
        spansById.set(t.speakerId, list);
    }
    const roster = new Map<string, RosterLike>();
    for (const s of speakers || []) if (s && s.id != null) roster.set(s.id, s);

    const perSpeaker = Array.from(spansById.entries()).map(([speakerId, spans]) => {
        const fused = fuseSpans(spans);
        const summed = Math.round(fused.reduce((acc, s) => acc + (s.end - s.start), 0));
        const row = roster.get(speakerId);
        const stat: Omit<SpeakerTalk, 'share'> = {
            speakerId,
            speakingSeconds: row ? Number(row.speakingSeconds) || 0 : summed,
            turnCount: fused.length,
            longestMonologue: longestOf(fused),
        };
        const summary = String(row?.summary || '').trim();
        if (summary) stat.summary = summary;
        return stat;
    });

    const totalSpeakingSeconds = perSpeaker.reduce((acc, s) => acc + s.speakingSeconds, 0);
    const ranked: SpeakerTalk[] = perSpeaker
        .map((s) => ({ ...s, share: totalSpeakingSeconds > 0 ? s.speakingSeconds / totalSpeakingSeconds : 0 }))
        .sort((a, b) => b.speakingSeconds - a.speakingSeconds);

    // Silence: recording time no speech span covers (a union — spans overlap).
    const union = fuseSpans(turns.map((t) => ({ start: t.start, end: t.end })).sort((a, b) => a.start - b.start));
    const covered = union.reduce(
        (acc, s) => acc + Math.max(0, Math.min(s.end, duration) - Math.min(s.start, duration)),
        0,
    );
    return {
        speakers: ranked,
        totalSpeakingSeconds,
        silenceSeconds: Math.max(0, Math.round(duration - covered)),
        topShare: ranked[0]?.share ?? 0,
        balance: balanceScore(ranked.map((s) => s.share)),
    };
}

export interface Interactivity {
    score: number;
    switches: number;
    switchesPerMinute: number;
    windows: { start: number; switches: number }[];
}

/**
 * How often the turn changed hands, 0–10 against a lively-dialogue benchmark.
 * Names nobody, so it shows even with per-person stats off.
 */
export function buildInteractivity(
    segments: readonly SegmentLike[] | null | undefined,
    durationSeconds: number | null | undefined,
    { windowSeconds = 300 }: { windowSeconds?: number } = {},
): Interactivity | null {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || turns.length < 2) return null;

    const windows: { start: number; switches: number }[] = [];
    for (let start = 0; start < duration; start += windowSeconds) windows.push({ start, switches: 0 });

    let switches = 0;
    for (let i = 1; i < turns.length; i++) {
        const turn = turns[i] as (typeof turns)[number];
        if (turn.speakerId === turns[i - 1]?.speakerId) continue;
        switches += 1;
        const w = windows[Math.min(windows.length - 1, Math.floor(turn.start / windowSeconds))];
        if (w) w.switches += 1;
    }
    const switchesPerMinute = switches / (duration / 60);
    return {
        score: Math.min(10, Math.round((switchesPerMinute / SWITCHES_PER_MINUTE_LIVELY) * 10)),
        switches,
        switchesPerMinute,
        windows,
    };
}

export interface TopTopic {
    title: string;
    seconds: number;
    share: number;
}

/** Chapters ranked by how much of the meeting they took. */
export function topTopics(
    chapters: readonly { title: string; seconds: number; widthFraction: number }[] | null | undefined,
    count = 3,
): TopTopic[] {
    return (Array.isArray(chapters) ? chapters : [])
        .slice()
        .sort((a, b) => b.widthFraction - a.widthFraction)
        .slice(0, count)
        .map((c) => ({ title: c.title, seconds: c.seconds, share: c.widthFraction }));
}

const normalizeName = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The speaker who most plausibly IS the viewer, or null: an exact full-name
 * match, else a unique first-name match. Ties answer null — a wrong match
 * would show someone else's numbers as "you".
 */
export function matchViewerSpeaker(
    speakers: readonly { id: string }[] | null | undefined,
    viewerName: string | null | undefined,
): string | null {
    const viewer = normalizeName(viewerName);
    if (!viewer) return null;
    const ids = (Array.isArray(speakers) ? speakers : []).filter((s) => s && s.id != null).map((s) => String(s.id));
    const exact = ids.filter((id) => normalizeName(id) === viewer);
    if (exact.length === 1) return exact[0] ?? null;
    if (exact.length > 1) return null;
    const viewerFirst = viewer.split(' ')[0] ?? '';
    if (viewerFirst.length < 2) return null;
    const byFirst = ids.filter((id) => normalizeName(id).split(' ')[0] === viewerFirst);
    return byFirst.length === 1 ? (byFirst[0] ?? null) : null;
}
