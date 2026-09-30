/**
 * Follow-up health, actions per topic, the whole Insights model and its
 * Overview highlights — the second half of a port of
 * agent-hub/src/pages/meeting-notes/lib/insightsMetrics.js, pinned to it by
 * insights.lockstep.test.ts.
 *
 * buildInsightsModel applies the organisation's per-person switch at BUILD
 * time: with it off, nothing that names a person is ever constructed, so no
 * rendering mistake can leak it.
 */

import {
    buildAirtimeWindows,
    buildDeadAir,
    buildHandoffPairs,
    buildMonologueRatio,
    buildSilentAttendees,
    buildSpeakerMetrics,
    buildTagMentions,
    buildTopicOwnership,
    insightsWindowSeconds,
    normalizeName,
    type AirtimeWindow,
    type DeadAir,
    type Handoff,
    type MonologueRatio,
    type SpeakerMetrics,
    type TagMention,
    type TopicBlock,
} from './flow';
import {
    buildInteractivity,
    buildTalkStats,
    topTopics,
    type Interactivity,
    type RosterLike,
    type SpeakerTalk,
    type TalkStats,
    type TopTopic,
} from './talk';
import { formatSpeakerLabel, normalizeChapters, toSeconds, type ChapterBlock, type ChapterLike, type SegmentLike } from './turns';

/** Assignee placeholders the summariser writes when nobody was named. */
const UNASSIGNED_LABELS = new Set(['niet toegewezen', 'unassigned', 'nobody', 'niemand', '']);

/** The part of the detail payload the Insights read. */
export interface InsightsInput {
    durationSeconds?: number | null;
    segments?: readonly SegmentLike[] | null;
    speakers?: readonly RosterLike[] | null;
    chapters?: readonly ChapterLike[] | null;
    tags?: readonly string[] | null;
    attendees?: readonly string[] | null;
    actionItems?: readonly { done?: boolean; assignee?: string; due?: string; timestamp?: string }[] | null;
    decisions?: readonly unknown[] | null;
    questions?: readonly { id?: string; text?: string; timestamp?: string; open?: boolean }[] | null;
}

export interface FollowUpStats {
    total: number;
    open: number;
    done: number;
    unassigned: number;
    withDue: number;
    overdue: number;
    decisions: number;
    decisionsPerHour: number;
    openQuestions: { id?: string; text: string; seconds: number | null }[];
    byAssignee: { assignee: string; total: number; open: number; overdue: number }[] | null;
}

const isUnassigned = (assignee: unknown) => UNASSIGNED_LABELS.has(normalizeName(assignee));

/** Local-calendar day key, so "overdue" follows the viewer's date, not UTC. */
function localDayKey(date: Date): string {
    if (Number.isNaN(date.getTime())) return '';
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${m}-${day}`;
}

type ItemLike = NonNullable<InsightsInput['actionItems']>[number];
type AssigneeRow = { assignee: string; total: number; open: number; overdue: number };

interface ItemTally {
    open: number;
    unassigned: number;
    withDue: number;
    overdue: number;
    byAssignee: Map<string, AssigneeRow>;
}

function tallyAssignee(tally: ItemTally, item: ItemLike, isOpen: boolean, isOverdue: boolean): void {
    if (isUnassigned(item.assignee)) {
        tally.unassigned += 1;
        return;
    }
    const key = String(item.assignee).trim();
    const row = tally.byAssignee.get(key) ?? { assignee: key, total: 0, open: 0, overdue: 0 };
    row.total += 1;
    if (isOpen) row.open += 1;
    if (isOverdue) row.overdue += 1;
    tally.byAssignee.set(key, row);
}

/**
 * Overdue compares the stored YYYY-MM-DD with the viewer's local date as a
 * plain string, so a note due "today" cannot read as overdue across a
 * timezone offset.
 */
function tallyItems(items: readonly ItemLike[], today: string): ItemTally {
    const tally: ItemTally = { open: 0, unassigned: 0, withDue: 0, overdue: 0, byAssignee: new Map() };
    for (const item of items) {
        const isOpen = !item.done;
        const due = typeof item.due === 'string' ? item.due.trim() : '';
        const isOverdue = isOpen && !!due && !!today && due < today;
        if (isOpen) tally.open += 1;
        if (due) tally.withDue += 1;
        if (isOverdue) tally.overdue += 1;
        tallyAssignee(tally, item, isOpen, isOverdue);
    }
    return tally;
}

const listOf = <T>(value: readonly T[] | null | undefined): T[] => (Array.isArray(value) ? value.filter(Boolean) : []);

/** What came out of the meeting and how much of it someone can pick up. `byAssignee` is PER-PERSON. */
export function buildFollowUpStats(meeting: InsightsInput | null | undefined, { now = new Date() } = {}): FollowUpStats {
    const items = listOf(meeting?.actionItems);
    const decisions = listOf(meeting?.decisions);
    const questions = listOf(meeting?.questions);
    const duration = Number(meeting?.durationSeconds) || 0;
    const { byAssignee, ...tally } = tallyItems(items, localDayKey(now));
    return {
        total: items.length,
        open: tally.open,
        done: items.length - tally.open,
        unassigned: tally.unassigned,
        withDue: tally.withDue,
        overdue: tally.overdue,
        decisions: decisions.length,
        decisionsPerHour: duration > 0 ? decisions.length / (duration / 3600) : 0,
        openQuestions: questions
            .filter((q) => q.open !== false)
            .map((q) => ({ id: q.id, text: String(q.text || ''), seconds: toSeconds(q.timestamp) })),
        byAssignee: Array.from(byAssignee.values()).sort((a, b) => b.total - a.total),
    };
}

/** Which chapter each action item was raised in. Counts only, no names. */
export function buildActionsPerTopic(
    actionItems: InsightsInput['actionItems'],
    chapters: readonly ChapterBlock[] | null | undefined,
): { title: string; seconds: number; count: number }[] {
    const blocks = Array.isArray(chapters) ? chapters : [];
    if (!blocks.length) return [];
    const counts = blocks.map((b) => ({ title: b.title, seconds: b.seconds, count: 0 }));
    for (const item of Array.isArray(actionItems) ? actionItems : []) {
        const at = toSeconds(item?.timestamp);
        if (at === null) continue;
        const idx = blocks.findIndex((b) => at >= b.seconds && at < b.endSeconds);
        const hit = counts[idx];
        if (hit) hit.count += 1;
    }
    return counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
}

export type PersonRow = SpeakerTalk & Partial<SpeakerMetrics>;

export interface Highlight {
    id: 'longest_monologue' | 'most_questions' | 'biggest_topic' | 'open_actions' | 'participants' | 'attention';
    label: string;
    value: number;
    kind: 'duration' | 'count' | 'percent' | 'hours';
    detail?: string;
    seconds?: number;
}

export interface InsightsModel {
    duration: number;
    talk: TalkStats;
    interactivity: Interactivity | null;
    perPersonEnabled: boolean;
    flow: {
        windowSeconds: number;
        monologue: MonologueRatio | null;
        deadAir: DeadAir[];
        airtime: AirtimeWindow[] | null;
        handoffs: Handoff[] | null;
    };
    topics: { blocks: TopicBlock[]; top: TopTopic[]; tags: TagMention[] };
    followUp: FollowUpStats;
    actionsPerTopic: { title: string; seconds: number; count: number }[];
    people: { rows: PersonRow[]; silentAttendees: string[] } | null;
    overview: Highlight[];
}

type Segments = InsightsInput['segments'];

function flowOf(segments: Segments, duration: number, windowSeconds: number, perPerson: boolean): InsightsModel['flow'] {
    return {
        windowSeconds,
        monologue: buildMonologueRatio(segments),
        deadAir: buildDeadAir(segments, duration),
        airtime: perPerson ? buildAirtimeWindows(segments, duration, { windowSeconds }) : null,
        handoffs: perPerson ? buildHandoffPairs(segments) : null,
    };
}

function topicsOf(meeting: InsightsInput, chapters: readonly ChapterBlock[], perPerson: boolean): InsightsModel['topics'] {
    const ownership = buildTopicOwnership(meeting.segments, chapters);
    return {
        // Time per topic is a meeting fact and stays; who drove it goes with the switch.
        blocks: perPerson
            ? ownership
            : ownership.map(({ topSpeakerId: _a, openedBy: _b, topSpeakerShare: _c, ...rest }) => rest),
        top: topTopics(chapters, 3),
        tags: buildTagMentions(meeting.tags, meeting.segments),
    };
}

function peopleOf(meeting: InsightsInput, talk: TalkStats, duration: number): NonNullable<InsightsModel['people']> {
    const metrics = buildSpeakerMetrics(meeting.segments, talk.speakers, duration);
    return {
        rows: talk.speakers.map((s) => ({ ...s, ...(metrics.get(s.speakerId) || {}) })),
        silentAttendees: buildSilentAttendees(meeting.attendees, talk.speakers),
    };
}

/** The whole model in one pass; null when there is not enough speech for any insight. */
export function buildInsightsModel(
    meeting: InsightsInput | null | undefined,
    { perPersonEnabled = true, now = new Date() }: { perPersonEnabled?: boolean; now?: Date } = {},
): InsightsModel | null {
    const duration = Number(meeting?.durationSeconds) || 0;
    const talk = buildTalkStats(meeting?.segments, meeting?.speakers, duration);
    if (!meeting || !talk) return null;
    const windowSeconds = insightsWindowSeconds(duration);
    const chapters = normalizeChapters(meeting.chapters, duration);
    const followUp = buildFollowUpStats(meeting, { now });
    const model: Omit<InsightsModel, 'overview'> = {
        duration,
        talk,
        interactivity: buildInteractivity(meeting.segments, duration, { windowSeconds }),
        perPersonEnabled,
        flow: flowOf(meeting.segments, duration, windowSeconds, perPersonEnabled),
        topics: topicsOf(meeting, chapters, perPersonEnabled),
        followUp: perPersonEnabled ? followUp : { ...followUp, byAssignee: null },
        actionsPerTopic: buildActionsPerTopic(meeting.actionItems, chapters),
        people: perPersonEnabled ? peopleOf(meeting, talk, duration) : null,
    };
    return { ...model, overview: buildOverviewHighlights(model) };
}

/**
 * The web model's English label per highlight. The phone never renders it —
 * OverviewTab words each id through t() — but the model carries it, as the
 * web's does.
 */
const HIGHLIGHT_LABEL = {
    longest_monologue: 'Longest monologue',
    most_questions: 'Most questions asked',
    biggest_topic: 'Biggest topic',
    open_actions: 'Open action items',
    participants: 'People who spoke',
    attention: 'Attention spent',
} as const satisfies Record<Highlight['id'], string>;

function longestHighlight(people: readonly PersonRow[]): Highlight | null {
    let longest: PersonRow | null = null;
    for (const s of people) {
        const seconds = s.longestMonologue?.seconds;
        if (seconds !== undefined && (!longest || seconds > (longest.longestMonologue?.seconds ?? 0))) longest = s;
    }
    const mono = longest?.longestMonologue;
    if (!longest || !mono) return null;
    return {
        id: 'longest_monologue',
        label: HIGHLIGHT_LABEL.longest_monologue,
        value: mono.seconds,
        kind: 'duration',
        detail: formatSpeakerLabel(longest.speakerId),
        seconds: mono.start,
    };
}

function askerHighlight(people: readonly PersonRow[]): Highlight | null {
    let asker: PersonRow | null = null;
    for (const s of people) if ((s.questionCount || 0) > (asker?.questionCount || 0)) asker = s;
    if (!asker?.questionCount) return null;
    return {
        id: 'most_questions',
        label: HIGHLIGHT_LABEL.most_questions,
        value: asker.questionCount,
        kind: 'count',
        detail: formatSpeakerLabel(asker.speakerId),
    };
}

function peopleHighlights(people: readonly PersonRow[]): Highlight[] {
    return [longestHighlight(people), askerHighlight(people)].filter((h): h is Highlight => h !== null);
}

/** The handful of numbers worth seeing without opening a tab; reads only the (gated) model. */
export function buildOverviewHighlights(model: Omit<InsightsModel, 'overview'>): Highlight[] {
    const out = peopleHighlights(model.people?.rows || []);
    const biggest = model.topics.top[0];
    if (biggest) {
        out.push({
            id: 'biggest_topic',
            label: HIGHLIGHT_LABEL.biggest_topic,
            value: Math.round(biggest.share * 100),
            kind: 'percent',
            detail: biggest.title,
            seconds: biggest.seconds,
        });
    }
    if (model.followUp.total > 0) {
        out.push({
            id: 'open_actions',
            label: HIGHLIGHT_LABEL.open_actions,
            value: model.followUp.open,
            kind: 'count',
            detail: model.followUp.unassigned > 0 ? `${model.followUp.unassigned} unassigned` : undefined,
        });
    }
    const activeSpeakers = model.talk.speakers.length;
    out.push({
        id: 'participants',
        label: HIGHLIGHT_LABEL.participants,
        value: activeSpeakers,
        kind: 'count',
        detail: model.people?.silentAttendees?.length ? `${model.people.silentAttendees.length} silent` : undefined,
    });
    out.push({
        id: 'attention',
        label: HIGHLIGHT_LABEL.attention,
        value: (model.duration * activeSpeakers) / 3600,
        kind: 'hours',
        detail: `${activeSpeakers} × ${Math.round(model.duration / 60)} min`,
    });
    return out;
}
