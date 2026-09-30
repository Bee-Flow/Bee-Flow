/**
 * Differential: the phone's Insights port and the web's own files
 * (agent-hub/src/pages/meeting-notes/lib/insightsMetrics.js, insightsData.js,
 * playerData.js, timelineMarkers.js, format.js) build the SAME model from the
 * same meetings — hand-written ones that hit the edges, and a few hundred
 * seeded random ones. When this fails the web side changed: update the port.
 */

import { loadWebModule } from '@/shared/testing/webModule';

import { buildInsightsModel } from './model';
import { matchViewerSpeaker } from './talk';
import { mergeTurns, normalizeChapters, toSeconds } from './turns';

/* eslint-disable @typescript-eslint/no-explicit-any -- the web modules are untyped JS */
const LIB = 'pages/meeting-notes/lib';
const markers: any = loadWebModule(`${LIB}/timelineMarkers.js`);
const format: any = loadWebModule(`${LIB}/format.js`);
const player: any = loadWebModule(`${LIB}/playerData.js`, {
    toSeconds: markers.toSeconds,
    SPEAKER_COLORS: ['#111111', '#222222'],
    NEUTRAL_SPEAKER_COLOR: '#999999',
});
const data: any = loadWebModule(`${LIB}/insightsData.js`, {
    mergeTurns: player.mergeTurns,
    fuseSpans: player.fuseSpans,
    segmentSpeakerId: player.segmentSpeakerId,
});
const metrics: any = loadWebModule(`${LIB}/insightsMetrics.js`, {
    formatSpeakerLabel: format.formatSpeakerLabel,
    buildInteractivity: data.buildInteractivity,
    buildTalkStats: data.buildTalkStats,
    topTopics: data.topTopics,
    fuseSpans: player.fuseSpans,
    mergeTurns: player.mergeTurns,
    normalizeChapters: player.normalizeChapters,
    segmentSpeakerId: player.segmentSpeakerId,
    toSeconds: markers.toSeconds,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const NOW = new Date(2026, 8, 20, 12, 0, 0);

const HAND_WRITTEN = [
    // Two people alternating, chapters, follow-up of every shape.
    {
        durationSeconds: 1500,
        segments: Array.from({ length: 40 }, (_, i) => ({
            speaker: i % 3 === 0 ? 'Tom Smit' : i % 3 === 1 ? 'Ans' : 'Spreker 3',
            start: i * 30 + (i % 4 === 0 ? 5 : 0),
            end: i * 30 + 28,
            text: i % 5 === 0 ? 'Gaan we de AI inzetten voor e-mail?' : 'Ja, dat doen we via de planning en AI.',
        })),
        speakers: [
            { id: 'Tom Smit', speakingSeconds: 400, summary: 'Leidde de vergadering.' },
            { id: 'Ans', speakingSeconds: 350 },
        ],
        chapters: [
            { title: 'Opening', start: '00:00' },
            { title: 'Planning', start: '05:10', summary: 'Wie doet wat' },
            { title: 'Planning', start: '05:10' },
            { title: 'Rondvraag', start: '19:00' },
            { title: 'Past the end', start: '40:00' },
            { title: '', start: '02:00' },
            { title: 'Junk', start: 'soon' },
        ],
        tags: ['AI', 'planning', 'e-mail', 'nooit gezegd'],
        attendees: ['Tom Smit', 'Ans de Vries', 'Karel', 'Anna'],
        actionItems: [
            { text: 'Mail sturen', assignee: 'Tom Smit', due: '2026-09-01', timestamp: '05:30' },
            { text: 'Plan maken', assignee: 'niet toegewezen', due: '2026-10-01', timestamp: '20:00', done: true },
            { text: 'Bellen', assignee: 'Ans', timestamp: '1:02:03' },
            { text: 'Iets', assignee: '', timestamp: 'later' },
        ],
        decisions: [{ text: 'We gaan door' }, { text: 'Budget akkoord' }],
        questions: [
            { text: 'Wanneer live?', timestamp: '12:00', open: true },
            { text: 'Wie betaalt?', open: false },
            { text: 'Welke tool?' },
        ],
    },
    // A monologue with a long lead-in and dead air, and an overlap.
    {
        durationSeconds: 900,
        segments: [
            { speaker: 'speaker_1', start: 60, end: 250, text: 'Een lang verhaal zonder vragen' },
            { speakerId: 'speaker_2', start: 240, end: 260, text: 'Hm?' },
            { speaker: 'speaker_1', start: 300, end: 500, text: 'nog meer' },
            { speaker: '', start: 500, end: 510, text: 'junk' },
            { speaker: 'speaker_1', start: 520, end: 510, text: 'backwards' },
        ],
        speakers: [],
        chapters: [],
    },
    // Too little for anything.
    { durationSeconds: 0, segments: [{ speaker: 'A', start: 0, end: 10, text: 'x' }] },
    { durationSeconds: 100, segments: [] },
    null,
];

/** A small deterministic generator: the same meetings on every run. */
function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function randomMeeting(seed: number) {
    const rnd = lcg(seed);
    const people = ['Tom', 'Ans', 'Jeroen de Boer', 'Speaker 4', 'Mark'].slice(0, 1 + Math.floor(rnd() * 5));
    const duration = Math.floor(rnd() * 5400);
    const segments = [];
    let at = rnd() * 40;
    while (at < duration * 1.05) {
        const len = 1 + rnd() * 120;
        const who = people[Math.floor(rnd() * people.length)] as string;
        segments.push({ speaker: who, start: at, end: at + len, text: rnd() < 0.2 ? 'Is dat zo? Mark zei ja.' : 'tom en ans praten' });
        at += len + (rnd() < 0.1 ? 30 + rnd() * 60 : rnd() * 2);
    }
    const mm = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return {
        durationSeconds: duration,
        segments,
        speakers: people.filter(() => rnd() < 0.6).map((id) => ({ id, speakingSeconds: Math.floor(rnd() * duration) })),
        chapters: Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ({ title: `Topic ${i}`, start: mm(rnd() * duration) })),
        tags: ['mark', 'tom', 'praten'].filter(() => rnd() < 0.5),
        attendees: ['Tom', 'Karel', 'Jeroen'].filter(() => rnd() < 0.5),
        actionItems: Array.from({ length: Math.floor(rnd() * 4) }, () => ({
            text: 'x',
            assignee: rnd() < 0.3 ? 'unassigned' : 'Tom',
            due: rnd() < 0.5 ? `2026-09-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}` : undefined,
            timestamp: mm(rnd() * duration),
            done: rnd() < 0.3,
        })),
        decisions: rnd() < 0.5 ? [{ text: 'd' }] : [],
        questions: rnd() < 0.5 ? [{ text: 'q', timestamp: mm(rnd() * duration) }] : [],
    };
}

const MEETINGS = [...HAND_WRITTEN, ...Array.from({ length: 300 }, (_, i) => randomMeeting(i + 1))];

describe('the Insights model matches the web’s', () => {
    it.each(MEETINGS.map((m, i) => [i, m] as const))('meeting %i, per-person on and off', (_i, meeting) => {
        for (const perPersonEnabled of [true, false]) {
            const phone = buildInsightsModel(meeting as never, { perPersonEnabled, now: NOW });
            const web = metrics.buildInsightsModel(meeting, { perPersonEnabled, now: NOW });
            expect(phone).toEqual(web);
        }
    });
});

describe('the helpers the model stands on match the web’s', () => {
    it('reads timestamps the same way', () => {
        for (const stamp of ['1:02', '01:02:03', '', ':30', '1:2:3:4', '-1:00', 'x', 12, NaN, null, '  3:05 ']) {
            expect(toSeconds(stamp)).toEqual(markers.toSeconds(stamp));
        }
    });

    it('merges turns and normalises chapters the same way', () => {
        for (const m of MEETINGS.slice(0, 60)) {
            expect(mergeTurns(m?.segments)).toEqual(player.mergeTurns(m?.segments));
            expect(normalizeChapters(m?.chapters, m?.durationSeconds)).toEqual(
                player.normalizeChapters(m?.chapters, m?.durationSeconds),
            );
        }
    });

    it('finds the viewer among the speakers the same way', () => {
        const speakers = [{ id: 'Tom Smit' }, { id: 'Tom de Vries' }, { id: 'Ans' }, { id: 'Anna Bakker' }];
        for (const viewer of ['Tom Smit', 'tom', 'Ans', 'Anna', 'A', '', 'Karel', 'anna  bakker']) {
            expect(matchViewerSpeaker(speakers, viewer)).toEqual(data.matchViewerSpeaker(speakers, viewer));
        }
    });
});

describe('the hand-written meetings reach every part of the model', () => {
    it('so the comparison above is not two empty answers agreeing', () => {
        const full = buildInsightsModel(HAND_WRITTEN[0] as never, { now: NOW });
        expect(full?.people?.rows.length).toBe(3);
        expect(full?.people?.silentAttendees).toEqual(['Karel', 'Anna']);
        expect(full?.topics.blocks.length).toBe(3);
        expect(full?.topics.tags.map((t) => t.tag)).toEqual(expect.arrayContaining(['AI', 'planning']));
        expect(full?.followUp).toMatchObject({ total: 4, open: 3, overdue: 1, decisions: 2 });
        expect(full?.flow.handoffs?.length).toBeGreaterThan(0);
        expect(full?.overview.map((h) => h.id)).toEqual(
            expect.arrayContaining(['longest_monologue', 'most_questions', 'biggest_topic', 'open_actions', 'participants', 'attention']),
        );
        const quiet = buildInsightsModel(HAND_WRITTEN[1] as never, { now: NOW });
        expect(quiet?.flow.deadAir.map((d) => d.kind)).toEqual(expect.arrayContaining(['lead_in', 'lead_out']));
        expect(quiet?.flow.monologue?.count).toBe(2);
        expect(buildInsightsModel(HAND_WRITTEN[0] as never, { perPersonEnabled: false, now: NOW })?.people).toBeNull();
    });
});
