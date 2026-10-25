import { mergeTurns, segmentSpeakerId } from './playerData';
import { toSeconds } from './timelineMarkers';
import type { TalkSpeaker } from '../detail/insights/insights.types';
import type { MeetingNote } from '../detail/meetingDetailTypes';
import type { PlayerSegment } from '../detail/player/player.types';

/** Below this much speech a words-per-minute figure is noise, so we hide it. */
const MIN_WPM_SPEAKING_SECONDS = 30;

/** Assignee placeholders the summariser writes when nobody was named. */
const UNASSIGNED_LABELS = new Set(['niet toegewezen', 'unassigned', 'nobody', 'niemand', '']);

/**
 * Window length for the over-time charts: aim for ~12 buckets so a 20-minute
 * stand-up and a 2-hour workshop both get a readable shape, clamped to
 * whole-minute steps between 1 and 10 minutes.
 */
export function insightsWindowSeconds(durationSeconds: number) {
    const duration = Number(durationSeconds) || 0;
    if (!duration) return 300;
    const target = Math.round(duration / 12 / 60) * 60;
    return Math.max(60, Math.min(600, target || 60));
}

function normalizeName(value: string) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Words in a transcript line: whitespace-split, tokens without a letter or digit dropped. */
export function countWords(text: string | null) {
    if (typeof text !== 'string' || !text.trim()) return 0;
    return text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Per-speaker delivery metrics: pace, turn shape, questions asked and how long
 * they spent listening. PER-PERSON.
 *
 * `speakingSeconds` is taken from the talk stats (the roster-backed number the
 * legend shows) so every surface reports the same seconds; words come from the
 * segments, which is why `wpm` is null for a speaker with almost no speech.
 *
 * @param {Array} segments
 * @param {Array<{speakerId: string, speakingSeconds: number, turnCount: number}>} talkSpeakers
 * @param {number} durationSeconds
 * @returns {Map<string, {words: number, wpm: number|null, questionCount: number,
 *                        avgTurnSeconds: number, listeningSeconds: number}>}
 */
export function buildSpeakerMetrics(segments: PlayerSegment[], talkSpeakers: TalkSpeaker[], durationSeconds: number) {
    const duration = Number(durationSeconds) || 0;
    const words = new Map();
    const questions = new Map();
    for (const seg of segments || []) {
        if (!seg || typeof seg.text !== 'string') continue;
        const id = segmentSpeakerId(seg);
        words.set(id, (words.get(id) || 0) + countWords(seg.text));
        if (seg.text.includes('?')) questions.set(id, (questions.get(id) || 0) + 1);
    }

    const out = new Map();
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
 * Attendees on the invite who never got a turn. PER-PERSON.
 *
 * Name matching reuses the conservative rules from matchViewerSpeaker: an
 * exact normalized match, else a unique first-name match. Anything ambiguous
 * counts as PRESENT — wrongly telling someone they said nothing is worse than
 * omitting a genuinely silent attendee.
 *
 * @param {Array<string>} attendees
 * @param {Array<{speakerId: string}>} talkSpeakers
 * @returns {Array<string>} attendee names, original casing
 */
export function buildSilentAttendees(attendees: string[], talkSpeakers: TalkSpeaker[] | undefined) {
    const list = (Array.isArray(attendees) ? attendees : []).map((a) => String(a || '').trim()).filter(Boolean);
    if (!list.length) return [];
    const ids = (talkSpeakers || []).map((s) => normalizeName(s.speakerId)).filter(Boolean);
    if (!ids.length) return list;

    return list.filter((name) => {
        const norm = normalizeName(name);
        if (!norm) return false;
        if (ids.some((id) => id === norm)) return false;
        const first = norm.split(' ')[0];
        if (first.length < 2) return false;
        // Ambiguity (two speakers sharing a first name) counts as present.
        return !ids.some((id) => id.split(' ')[0] === first);
    });
}

/**
 * Share of each window's speech per speaker — "who dominated when".
 * PER-PERSON.
 *
 * The value is the share of the speech IN THAT WINDOW, not of the meeting, so
 * a quiet stretch still shows who held it. Windows with no speech are kept
 * (with an empty `shares`) so the x-axis stays linear in time.
 *
 * @returns {Array<{start: number, end: number, speechSeconds: number,
 *                  shares: Array<{speakerId: string, seconds: number, share: number}>}>}
 */
export function buildAirtimeWindows(segments: PlayerSegment[], durationSeconds: number, { windowSeconds }: { windowSeconds?: number } = {}) {
    const duration = Number(durationSeconds) || 0;
    const turns = mergeTurns(segments);
    if (!duration || !turns.length) return [];
    const size = windowSeconds || insightsWindowSeconds(duration);

    const windows = [];
    for (let start = 0; start < duration; start += size) {
        windows.push({ start, end: Math.min(duration, start + size), byId: new Map() });
    }
    if (!windows.length) return [];

    for (const turn of turns) {
        const from = Math.max(0, Math.min(turn.start, duration));
        const to = Math.max(0, Math.min(turn.end, duration));
        if (to <= from) continue;
        const firstIdx = Math.min(windows.length - 1, Math.floor(from / size));
        for (let i = firstIdx; i < windows.length && windows[i].start < to; i++) {
            const overlap = Math.min(to, windows[i].end) - Math.max(from, windows[i].start);
            if (overlap <= 0) continue;
            windows[i].byId.set(turn.speakerId, (windows[i].byId.get(turn.speakerId) || 0) + overlap);
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

function isUnassigned(assignee: string | undefined) {
    return UNASSIGNED_LABELS.has(normalizeName(assignee as string));
}

/** Local-calendar day key, so "overdue" follows the user's date, not UTC. */
function localDayKey(date: Date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Follow-up health: what came out of the meeting and how much of it is
 * actionable. `byAssignee` is PER-PERSON; every other field is meeting-level.
 *
 * Overdue compares the stored YYYY-MM-DD against the viewer's local date as a
 * plain string — no Date parsing, so a note dated "today" can never read as
 * overdue because of a timezone offset.
 *
 * @returns {{total, open, done, unassigned, withDue, overdue, decisions,
 *            decisionsPerHour, openQuestions: Array<{id, text, seconds: number|null}>,
 *            byAssignee: Array<{assignee, total, open, overdue}>}}
 */
export function buildFollowUpStats(meeting: MeetingNote | null | undefined, { now = new Date() } = {}) {
    const items = Array.isArray(meeting?.actionItems) ? meeting.actionItems.filter(Boolean) : [];
    const decisions = Array.isArray(meeting?.decisions) ? meeting.decisions.filter(Boolean) : [];
    const questions = Array.isArray(meeting?.questions) ? meeting.questions.filter(Boolean) : [];
    const duration = Number(meeting?.durationSeconds) || 0;
    const today = localDayKey(now);

    let open = 0;
    let unassigned = 0;
    let withDue = 0;
    let overdue = 0;
    const byAssignee = new Map();
    for (const item of items) {
        const isOpen = !item.done;
        if (isOpen) open += 1;
        if (isUnassigned(item.assignee)) unassigned += 1;
        const due = typeof item.due === 'string' ? item.due.trim() : '';
        const isOverdue = isOpen && !!due && !!today && due < today;
        if (due) withDue += 1;
        if (isOverdue) overdue += 1;

        if (!isUnassigned(item.assignee)) {
            const key = String(item.assignee).trim();
            const row = byAssignee.get(key) || { assignee: key, total: 0, open: 0, overdue: 0 };
            row.total += 1;
            if (isOpen) row.open += 1;
            if (isOverdue) row.overdue += 1;
            byAssignee.set(key, row);
        }
    }

    return {
        total: items.length,
        open,
        done: items.length - open,
        unassigned,
        withDue,
        overdue,
        decisions: decisions.length,
        decisionsPerHour: duration > 0 ? decisions.length / (duration / 3600) : 0,
        openQuestions: questions
            .filter((q) => q.open !== false)
            .map((q) => ({ id: q.id, text: String(q.text || ''), seconds: toSeconds(q.timestamp) })),
        byAssignee: Array.from(byAssignee.values()).sort((a, b) => b.total - a.total),
    };
}
