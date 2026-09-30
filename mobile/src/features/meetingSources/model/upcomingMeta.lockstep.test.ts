/**
 * Differential: the port and agent-hub's upcomingMeta.js say the same things
 * about the same meetings — including every "we do not know" case. When this
 * fails the web side changed; update upcomingMeta.ts.
 */

import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import {
    attendeeCountOf,
    attendeeNotices,
    durationPhrase,
    meetingTags,
    metaSegments,
    recordReasonHint,
    toggleStateLabel,
    type NoticeRow,
} from './upcomingMeta';
import * as when from './when';

const LIB = path.resolve(__dirname, '../../../../../agent-hub/src');
/** The web module's two imports: its own when-helpers (pinned by when.lockstep) and `nOf`. */
const plural = loadWebModule<Record<string, unknown>>(`${LIB}/components/admin/Studio/KnowledgeStudio/plural.js`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const web: any = loadWebModule(`${LIB}/pages/meeting-notes/lib/upcomingMeta.js`, { ...when, nOf: plural.nOf });

/** Both sides get the same catalogue: the fallback with its {params} filled in. */
const t = (_key: string, fallback: string, params: Record<string, string | number> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));

const MEETINGS: Record<string, unknown>[] = [
    { start: '2026-07-18T14:00:00Z', end: '2026-07-18T15:30:00Z', attendees: ['a@x.nl', 'b@x.nl'] },
    { start: '2026-07-18', end: '2026-07-19', attendees: [] },
    { start: null, end: null },
    { start: '2026-07-18T14:00:00Z', end: null, participantCount: 1 },
    { start: '2026-07-18T14:00:00Z', end: '2026-07-18T14:20:00Z', participantCount: 0 },
    { start: '2026-07-18T14:00:00Z', end: '2026-07-18T16:00:00Z', participantCount: -3 },
    {
        start: '2026-07-18T14:00:00Z',
        end: '2026-07-18T15:00:00Z',
        attendees: [{ email: 'A@x.nl' }, { cn: 'Bob' }, {}, 'a@x.nl'],
        organizerEmail: 'boss@x.nl',
    },
    { attendees: [], organizer: { cn: 'Host' } },
    { attendees: [], organizer: 'solo@x.nl', tags: ['sales', ' ', 3, ' q3 '] },
];

describe('upcomingMeta.ts matches upcomingMeta.js', () => {
    it.each(MEETINGS.map((m, i) => [i, m]))('meeting %i: count, segments and tags', (_i, meeting) => {
        expect(attendeeCountOf(meeting)).toBe(web.attendeeCountOf(meeting));
        expect(metaSegments(meeting as { start: unknown; end: unknown }, t)).toEqual(web.metaSegments(meeting, t));
        expect(meetingTags(meeting)).toEqual(web.meetingTags(meeting));
    });

    it('phrases a duration the same way', () => {
        for (const minutes of [null, 5, 60, 90, 120, 125]) {
            expect(durationPhrase(minutes, t)).toBe(web.durationPhrase(minutes, t));
        }
    });

    it('explains an off switch the same way', () => {
        const reasons = [null, 'opted_in', 'opted_out', 'small_meeting', 'unknown_size', 'whatever'];
        for (const reason of reasons) {
            for (const record of [true, false]) {
                for (const opts of [{}, { recordDecided: false }, { overridden: true }, { recordDecided: true }]) {
                    expect(recordReasonHint(reason, record, t, opts)).toBe(web.recordReasonHint(reason, record, t, opts));
                }
            }
        }
        for (const record of [true, false]) {
            for (const decided of [true, false, undefined]) {
                expect(toggleStateLabel(record, decided, t)).toBe(web.toggleStateLabel(record, decided, t));
            }
        }
    });

    it('picks the same footer notices', () => {
        const cases: { rows: NoticeRow[]; postSummaryBack: boolean | undefined; meetAutoRecordArmed: boolean }[] = [
            { rows: [{ provider: 'talk', status: 'will_record' }], postSummaryBack: true, meetAutoRecordArmed: false },
            { rows: [{ provider: 'talk', status: 'will_record' }], postSummaryBack: false, meetAutoRecordArmed: false },
            { rows: [{ provider: 'talk', status: 'upcoming' }], postSummaryBack: true, meetAutoRecordArmed: false },
            { rows: [{ provider: 'talk', status: 'recording_now' }], postSummaryBack: undefined, meetAutoRecordArmed: false },
            {
                rows: [{ provider: 'gmeet', status: 'will_record', organizerSelf: true }],
                postSummaryBack: undefined,
                meetAutoRecordArmed: true,
            },
            {
                rows: [{ provider: 'gmeet', status: 'manual_record', organizerSelf: false }],
                postSummaryBack: undefined,
                meetAutoRecordArmed: true,
            },
        ];
        for (const c of cases) {
            const webRows = c.rows.map((r) => ({ provider: r.provider, status: r.status, m: { organizerSelf: r.organizerSelf } }));
            const theirs = web
                .attendeeNotices({ ...c, rows: webRows })
                .map((n: { key: string; en: string }) => ({ i18nKey: n.key, en: n.en }));
            expect(attendeeNotices(c)).toEqual(theirs);
        }
    });
});
