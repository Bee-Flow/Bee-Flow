import { formatSpeakerLabel } from './format';
import { buildInteractivity, buildTalkStats, topTopics } from './insightsData';
import { fuseSpans, mergeTurns, normalizeChapters } from './playerData';
import { toSeconds } from './timelineMarkers';
import type { InsightsModel, Monologue, PersonStat } from '../detail/insights/insights.types';
import type { MeetingNote } from '../detail/meetingDetailTypes';
import type { PlayerSegment } from '../detail/player/player.types';
import { insightsWindowSeconds, buildSpeakerMetrics, buildSilentAttendees, buildAirtimeWindows, buildFollowUpStats } from './insightsMetrics.helpers';
export { insightsWindowSeconds, countWords, buildSpeakerMetrics, buildSilentAttendees, buildAirtimeWindows, buildFollowUpStats } from './insightsMetrics.helpers';

/**
 * Derivations for the tabbed Insights panel — everything beyond the original
 * talk-time/balance math in ./insightsData.js. Pure functions over the detail
 * payload; no DOM, no network, nothing persisted.
 *
 * PRIVACY: builders whose output names an individual are marked "per-person"
 * below. Callers should not hand-pick them — use {@link buildInsightsModel},
 * which OMITS those keys entirely when the org disables per-person stats, so a
 * rendering mistake cannot leak attribution that the model never built.
 */

/** Turns at or above this length count as a monologue (mirrors insightsData). */
const MONOLOGUE_SECONDS = 90;
/** Gaps in the speech union at least this long are listed as dead air. */
const DEAD_AIR_SECONDS = 20;
/** Handoff pairs mean nothing until the conversation actually changed hands. */
const MIN_HANDOFF_SWITCHES = 4;

function escapeRegExp(value: string) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Who tends to speak right after whom. PER-PERSON.
 *
 * Directed pairs over consecutive turns; same-speaker transitions can't occur
 * (mergeTurns already fused them). Returns [] below MIN_HANDOFF_SWITCHES so a
 * three-switch meeting doesn't get a "conversation partners" ranking.
 *
 * @returns {Array<{from: string, to: string, count: number}>}
 */
export function buildHandoffPairs(segments: PlayerSegment[], { limit = 5 } = {}) {
    const turns = mergeTurns(segments);
    if (turns.length < 2) return [];
    // Nested map, NOT a joined string key. Speaker ids here are DISPLAY NAMES,
    // and the default label is "Spreker 1" / "Speaker 1" — so joining on a space
    // and splitting on the first one mangled essentially every meeting:
    // "Tom Smit → Ans" came back as "Tom → Smit", and "Spreker 1 → Spreker 2"
    // and "Spreker 1 → Spreker 3" both collapsed to "Spreker → Speaker 1",
    // colliding into two identical rows.
    const counts = new Map();
    let switches = 0;
    for (let i = 1; i < turns.length; i++) {
        const from = turns[i - 1].speakerId;
        const to = turns[i].speakerId;
        if (from === to) continue;
        switches += 1;
        if (!counts.has(from)) counts.set(from, new Map());
        const inner = counts.get(from);
        inner.set(to, (inner.get(to) || 0) + 1);
    }
    if (switches < MIN_HANDOFF_SWITCHES) return [];
    const pairs = [];
    for (const [from, inner] of counts) {
        for (const [to, count] of inner) pairs.push({ from, to, count });
    }
    return pairs
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/**
 * Stretches where nobody spoke. Meeting-level (a gap belongs to no one).
 *
 * Gaps come from the fused UNION of speech, so overlapping speakers can't
 * manufacture one. Lead-in and lead-out are included but tagged, because
 * "the first 4 minutes were setup" is worth seeing yet is not the same as the
 * room falling quiet mid-discussion.
 *
 * @returns {Array<{start: number, end: number, seconds: number, kind: 'lead_in'|'gap'|'lead_out'}>}
 */
export function buildDeadAir(segments: PlayerSegment[], durationSeconds: number, { minSeconds = DEAD_AIR_SECONDS, limit = 5 } = {}) {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || !turns.length) return [];
    const union = fuseSpans(
        turns.map((t) => ({ start: Math.max(0, t.start), end: Math.min(t.end, duration) }))
            .filter((s) => s.end > s.start)
            .sort((a, b) => a.start - b.start),
    );
    if (!union.length) return [];

    const gaps = [];
    if (union[0].start >= minSeconds) {
        gaps.push({ start: 0, end: union[0].start, kind: 'lead_in' });
    }
    for (let i = 1; i < union.length; i++) {
        if (union[i].start - union[i - 1].end >= minSeconds) {
            gaps.push({ start: union[i - 1].end, end: union[i].start, kind: 'gap' });
        }
    }
    const lastEnd = union[union.length - 1].end;
    if (duration - lastEnd >= minSeconds) {
        gaps.push({ start: lastEnd, end: duration, kind: 'lead_out' });
    }

    return gaps
        .map((g) => ({ ...g, start: Math.round(g.start), end: Math.round(g.end), seconds: Math.round(g.end - g.start) }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, limit);
}

/**
 * How much of the speaking time went into long uninterrupted stretches.
 * Meeting-level: a ratio over all turns, naming nobody.
 *
 * @returns {null | {seconds: number, totalSeconds: number, ratio: number, count: number}}
 */
export function buildMonologueRatio(segments: PlayerSegment[]) {
    const turns = mergeTurns(segments);
    if (!turns.length) return null;
    let total = 0;
    let mono = 0;
    let count = 0;
    for (const t of turns) {
        const len = t.end - t.start;
        if (len <= 0) continue;
        total += len;
        if (len >= MONOLOGUE_SECONDS) { mono += len; count += 1; }
    }
    if (total <= 0) return null;
    return { seconds: Math.round(mono), totalSeconds: Math.round(total), ratio: mono / total, count };
}

/**
 * Per chapter: how long it ran, who spoke most inside it and who opened it.
 * The speaker fields are PER-PERSON; `blocks` without them is meeting-level.
 *
 * A turn straddling a boundary is split by overlap, so its seconds land in
 * whichever chapters it actually covered rather than in the one it started in.
 *
 * @param {Array} segments
 * @param {Array} normalizedChapters output of normalizeChapters
 * @returns {Array<{title, seconds, endSeconds, widthFraction, topSpeakerId: string|null,
 *                  topSpeakerShare: number, openedBy: string|null}>}
 */
export function buildTopicOwnership(segments: PlayerSegment[], normalizedChapters: { title: string; seconds: number; endSeconds: number; fraction: number; widthFraction: number; summary: string | null; }[]) {
    const blocks = Array.isArray(normalizedChapters) ? normalizedChapters : [];
    if (!blocks.length) return [];
    const turns = mergeTurns(segments);

    return blocks.map((block) => {
        const byId = new Map();
        let opener = null;
        let openerStart = Infinity;
        for (const turn of turns) {
            const overlap = Math.min(turn.end, block.endSeconds) - Math.max(turn.start, block.seconds);
            if (overlap <= 0) continue;
            byId.set(turn.speakerId, (byId.get(turn.speakerId) || 0) + overlap);
            if (turn.start < openerStart) { openerStart = turn.start; opener = turn.speakerId; }
        }
        const total = Array.from(byId.values()).reduce((acc, v) => acc + v, 0);
        let topSpeakerId = null;
        let topSeconds = 0;
        for (const [id, secs] of byId.entries()) {
            if (secs > topSeconds) { topSeconds = secs; topSpeakerId = id; }
        }
        return {
            ...block,
            topSpeakerId,
            topSpeakerShare: total > 0 ? topSeconds / total : 0,
            openedBy: opener,
        };
    });
}

/**
 * How often each auto-generated tag is actually said, and where it first came
 * up. Meeting-level. Multi-word tags tolerate any whitespace between words;
 * matching is case-insensitive on Unicode word boundaries so "AI" doesn't fire
 * inside "email".
 *
 * @returns {Array<{tag: string, count: number, firstSeconds: number|null}>}
 */
export function buildTagMentions(tags: string[] | undefined, segments: PlayerSegment[]) {
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

/**
 * Which chapter each action item was raised in — "we agreed this while talking
 * about X". Meeting-level (counts only, no names).
 *
 * @returns {Array<{title: string, seconds: number, count: number}>}
 */
export function buildActionsPerTopic(actionItems: { id?: string; text?: string; assignee?: string; done?: boolean; source?: string; timestamp?: number | string }[], normalizedChapters: { title: string; seconds: number; endSeconds: number; fraction: number; widthFraction: number; summary: string | null; }[]) {
    const blocks = Array.isArray(normalizedChapters) ? normalizedChapters : [];
    if (!blocks.length) return [];
    const counts = blocks.map((b) => ({ title: b.title, seconds: b.seconds, count: 0 }));
    for (const item of (Array.isArray(actionItems) ? actionItems : [])) {
        const at = toSeconds(item?.timestamp);
        if (at === null) continue;
        const idx = blocks.findIndex((b) => at >= b.seconds && at < b.endSeconds);
        if (idx >= 0) counts[idx].count += 1;
    }
    return counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
}

/**
 * The whole Insights model in one pass, with the per-person gate applied at
 * BUILD time: when `perPersonEnabled` is false the individual rows are never
 * constructed, so no rendering mistake downstream can leak attribution.
 *
 * @param {object} meeting detail payload
 * @param {{perPersonEnabled?: boolean, now?: Date}} [opts]
 * @returns {null | object} null when there is not enough speech for any insight
 */
export function buildInsightsModel(meeting: MeetingNote | null | undefined, { perPersonEnabled = true, now = new Date() } = {}) {
    const duration = Number(meeting?.durationSeconds) || 0;
    const segments = meeting?.segments as PlayerSegment[];
    const talk = buildTalkStats(segments, meeting?.speakers as Parameters<typeof buildTalkStats>[1], duration);
    if (!talk) return null;

    const windowSeconds = insightsWindowSeconds(duration);
    const interactivity = buildInteractivity(segments, duration, { windowSeconds });
    const chapters = normalizeChapters(meeting?.chapters as Parameters<typeof normalizeChapters>[0], duration);
    const followUp = buildFollowUpStats(meeting, { now });
    const ownership = buildTopicOwnership(segments, chapters);

    const model = {
        duration,
        talk,
        interactivity,
        perPersonEnabled,
        flow: {
            windowSeconds,
            monologue: buildMonologueRatio(segments),
            deadAir: buildDeadAir(segments, duration),
            airtime: perPersonEnabled ? buildAirtimeWindows(segments, duration, { windowSeconds }) : null,
            handoffs: perPersonEnabled ? buildHandoffPairs(segments) : null,
        },
        topics: {
            blocks: perPersonEnabled
                ? ownership
                // Strip attribution but keep the durations: "time per topic" is
                // a meeting-level fact and stays visible with the gate off.
                : ownership.map(({ topSpeakerId, openedBy, topSpeakerShare, ...rest }) => rest),
            top: topTopics(chapters, 3),
            tags: buildTagMentions(meeting?.tags, segments),
        },
        followUp: perPersonEnabled ? followUp : { ...followUp, byAssignee: null },
        actionsPerTopic: buildActionsPerTopic(meeting?.actionItems as Parameters<typeof buildActionsPerTopic>[0], chapters),
        people: null,
    } as InsightsModel;

    if (perPersonEnabled) {
        const metrics = buildSpeakerMetrics(segments, talk.speakers, duration);
        model.people = {
            rows: talk.speakers.map((s) => ({ ...s, ...(metrics.get(s.speakerId) || {}) })),
            silentAttendees: buildSilentAttendees(meeting?.attendees as string[], talk.speakers),
        };
    }

    model.overview = buildOverviewHighlights(model);
    return model;
}

/**
 * The handful of numbers worth seeing without opening a tab. Reads only the
 * model, so anything the gate removed simply doesn't produce a highlight.
 *
 * @returns {Array<{id, label, value, detail?: string, seconds?: number}>}
 */
export function buildOverviewHighlights(model: InsightsModel) {
    const out = [];
    const people = model.people?.rows || [];

    const longest = people.reduce(
        (best: PersonStat | null, s: PersonStat) => (s.longestMonologue && (!best || (s.longestMonologue as Monologue).seconds > (best.longestMonologue as Monologue).seconds) ? s : best),
        null,
    );
    if (longest) {
        out.push({
            id: 'longest_monologue',
            label: 'Longest monologue',
            value: (longest.longestMonologue as Monologue).seconds,
            kind: 'duration',
            detail: formatSpeakerLabel(longest.speakerId),
            seconds: (longest.longestMonologue as Monologue).start,
        });
    }

    const asker = people.reduce((best: PersonStat | null, s: PersonStat) => ((s.questionCount || 0) > (best?.questionCount || 0) ? s : best), null);
    if (asker && asker.questionCount > 0) {
        out.push({
            id: 'most_questions',
            label: 'Most questions asked',
            value: asker.questionCount,
            kind: 'count',
            detail: formatSpeakerLabel(asker.speakerId),
        });
    }

    const biggest = model.topics.top[0];
    if (biggest) {
        out.push({
            id: 'biggest_topic',
            label: 'Biggest topic',
            value: Math.round(biggest.share * 100),
            kind: 'percent',
            detail: biggest.title,
            seconds: biggest.seconds,
        });
    }

    if (model.followUp.total > 0) {
        out.push({
            id: 'open_actions',
            label: 'Open action items',
            value: model.followUp.open,
            kind: 'count',
            detail: model.followUp.unassigned > 0 ? `${model.followUp.unassigned} unassigned` : undefined,
        });
    }

    const activeSpeakers = model.talk.speakers.length;
    out.push({
        id: 'participants',
        label: 'People who spoke',
        value: activeSpeakers,
        kind: 'count',
        detail: model.people?.silentAttendees?.length
            ? `${model.people.silentAttendees.length} silent`
            : undefined,
    });

    // Attention spent: everyone in the room was in it for the whole recording.
    out.push({
        id: 'attention',
        label: 'Attention spent',
        value: (model.duration * activeSpeakers) / 3600,
        kind: 'hours',
        detail: `${activeSpeakers} × ${Math.round(model.duration / 60)} min`,
    });

    return out;
}
