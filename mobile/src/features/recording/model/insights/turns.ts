/**
 * The meeting player's turn and chapter rules the Insights math stands on —
 * a port of agent-hub/src/pages/meeting-notes/lib/playerData.js
 * (segmentSpeakerId, mergeTurns, fuseSpans, normalizeChapters),
 * timelineMarkers.js (toSeconds) and format.js (formatSpeakerLabel), pinned
 * to them by insights.lockstep.test.ts.
 *
 * mergeTurns is the ONE turn definition every insight uses: if the phone's
 * turns differed from the web's, the same meeting would report a different
 * longest monologue in the browser and on the phone.
 */

export interface SegmentLike {
    speaker?: string | null;
    speakerId?: string | null;
    start: number;
    end: number;
    text?: string;
}

export interface Span {
    start: number;
    end: number;
}

export interface Turn extends Span {
    speakerId: string;
}

export interface ChapterLike {
    title?: string | null;
    start?: string | number | null;
    summary?: string | null;
}

export interface ChapterBlock {
    title: string;
    seconds: number;
    endSeconds: number;
    fraction: number;
    widthFraction: number;
    summary: string | null;
}

/** A segment's speaker: `speaker`, else `speakerId`, else the backend's own 'Unknown'. */
export function segmentSpeakerId(seg: SegmentLike | null | undefined): string {
    return (seg && (seg.speaker || seg.speakerId)) || 'Unknown';
}

/**
 * Segments → chronological speaker turns, merging consecutive same-speaker
 * segments and bridging the diarizer's hairline gaps (≤1s). Junk is skipped.
 */
export function mergeTurns(segments: readonly (SegmentLike | null | undefined)[] | null | undefined): Turn[] {
    const turns: Turn[] = [];
    for (const seg of segments || []) {
        if (!seg) continue;
        const speakerId = seg.speaker || seg.speakerId;
        const start = Number(seg.start);
        const end = Number(seg.end);
        if (!speakerId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const last = turns[turns.length - 1];
        if (last && last.speakerId === speakerId && start <= last.end + 1) {
            last.end = Math.max(last.end, end);
        } else {
            turns.push({ speakerId, start: Math.max(0, start), end });
        }
    }
    return turns;
}

/** Merge chronological spans whose gap is ≤1s. */
export function fuseSpans(spans: readonly Span[]): Span[] {
    const fused: Span[] = [];
    for (const s of spans) {
        const last = fused[fused.length - 1];
        if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
        else fused.push({ start: s.start, end: s.end });
    }
    return fused;
}

/**
 * `MM:SS` / `HH:MM:SS` → seconds, or null when it is not a timestamp at all —
 * never 0, which would read as a genuine moment at the very start.
 */
export function toSeconds(stamp: unknown): number | null {
    if (typeof stamp === 'number') return Number.isFinite(stamp) ? stamp : null;
    if (typeof stamp !== 'string') return null;
    const parts = stamp.trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    const [a = 0, b = 0, c = 0] = nums;
    return nums.length === 3 ? a * 3600 + b * 60 + c : a * 60 + b;
}

/**
 * The model's chapters, validated: unreadable or out-of-range starts dropped,
 * order enforced, duplicates removed, and each block ending where the next
 * begins so the strip tiles the recording. A lone chapter says nothing: [].
 */
export function normalizeChapters(
    chapters: readonly (ChapterLike | null | undefined)[] | null | undefined,
    durationSeconds: number | null | undefined,
): ChapterBlock[] {
    const duration = Number(durationSeconds) || 0;
    if (!duration || !Array.isArray(chapters)) return [];
    const placed = chapters
        .map((c) => {
            if (!c) return null;
            const seconds = toSeconds(c.start);
            const title = String(c.title || '').trim();
            if (seconds === null || seconds >= duration || !title) return null;
            return { title, seconds, summary: String(c.summary || '').trim() || null };
        })
        .filter((c): c is { title: string; seconds: number; summary: string | null } => c !== null)
        .sort((a, b) => a.seconds - b.seconds)
        .filter((c, i, arr) => i === 0 || c.seconds > (arr[i - 1]?.seconds ?? -1));
    if (placed.length < 2) return [];
    return placed.map((c, i) => {
        const endSeconds = placed[i + 1]?.seconds ?? duration;
        return {
            title: c.title,
            seconds: c.seconds,
            endSeconds,
            fraction: c.seconds / duration,
            widthFraction: (endSeconds - c.seconds) / duration,
            summary: c.summary,
        };
    });
}

/** "speaker_2" → "Speaker 2", "anna" → "Anna". */
export function formatSpeakerLabel(id: string | null | undefined): string {
    if (!id) return 'Speaker';
    const cleaned = String(id).replace(/^speaker[_\s-]?/i, '');
    if (/^\d+$/.test(cleaned)) return `Speaker ${cleaned}`;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
