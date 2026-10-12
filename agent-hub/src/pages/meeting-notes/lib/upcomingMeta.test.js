// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    parseWhen,
    meetingDurationMinutes,
    attendeeCountOf,
    meetingTags,
    dateBlockParts,
    timeRange,
    durationPhrase,
    metaSegments,
    recordReasonHint,
    toggleStateLabel,
    attendeeNotices,
    NOTICE_TALK_POST,
    NOTICE_TALK_QUIET,
    NOTICE_MEET_SHARE,
    NOTICE_TEAMS_SHARE,
    NOTICE_TEAMS_AUTORECORD,
    NOTICE_MEET_AUTORECORD,
} from './upcomingMeta';

/**
 * De regels achter de Gepland-metaregel. Waar het hier om gaat is EERLIJKHEID
 * over wat niet bekend is: geen provider levert een duur, Talk levert alleen
 * de ICS-ATTENDEE-lijst (leeg bij een ad-hoc room), en een nul die eigenlijk
 * onbekend is, is in dit programma al drie keer een bevinding geweest.
 */

const t = (key, fallback, vars) => String(fallback).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));

const talkMeeting = (over = {}) => ({
    talkToken: 'tok1', uid: 'uid1', title: 'Talk standup',
    start: '2026-07-18T09:00:00Z', end: '2026-07-18T09:30:00Z',
    organizer: { cn: 'Sanne', email: 'sanne@example.com' },
    attendees: [{ cn: 'Ines', email: 'ines@example.com' }, { cn: 'Joris', email: 'joris@example.com' }],
    ...over,
});

describe('upcomingMeta — duur', () => {
    it('leidt de duur af uit start/end en houdt onbekend onbekend', () => {
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T09:30:00Z')).toBe(30);
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T10:30:00Z')).toBe(90);
        // Geen einde: talkCalendar geeft `end: ev.dtend || null`.
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', null)).toBeNull();
        expect(meetingDurationMinutes(null, '2026-07-18T09:30:00Z')).toBeNull();
        // Hele dag: een DATUM is geen lengte (gmeetCalendar valt terug op start.date).
        expect(meetingDurationMinutes('2026-07-18', '2026-07-19')).toBeNull();
        // Een einde vóór of op het begin is geen duur van -30 en geen 0.
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T08:30:00Z')).toBeNull();
        expect(meetingDurationMinutes('2026-07-18T09:00:00Z', '2026-07-18T09:00:00Z')).toBeNull();
        expect(meetingDurationMinutes('geen-datum', '2026-07-18T09:30:00Z')).toBeNull();
    });

    it('schrijft de duur uit zonder meervoudsval', () => {
        expect(durationPhrase(30, t)).toBe('30 min');
        expect(durationPhrase(120, t)).toBe('2 hr');
        expect(durationPhrase(90, t)).toBe('1 hr 30 min');
        expect(durationPhrase(null, t)).toBe('');
    });
});

describe('upcomingMeta — tijd en datum', () => {
    it('leest een kale datum als LOKALE middernacht, zodat de dag op het scherm de dag uit de uitnodiging is', () => {
        const when = parseWhen('2026-07-18');
        expect(when.dateOnly).toBe(true);
        expect(when.date.getFullYear()).toBe(2026);
        expect(when.date.getMonth()).toBe(6);
        expect(when.date.getDate()).toBe(18);
    });

    it('geeft NULL bij niets bruikbaars — nooit "nu"', () => {
        expect(parseWhen(null)).toBeNull();
        expect(parseWhen('')).toBeNull();
        expect(parseWhen('   ')).toBeNull();
        expect(parseWhen('geen-datum')).toBeNull();
        expect(parseWhen(new Date('geen-datum'))).toBeNull();
        expect(dateBlockParts(null)).toBeNull();
    });

    it('een hele dag heeft geen tijdvak', () => {
        expect(timeRange('2026-07-18', '2026-07-19')).toBe('');
        expect(timeRange('2026-07-18T09:00:00Z', null)).not.toBe('');
        expect(timeRange('2026-07-18T09:00:00Z', '2026-07-18T09:30:00Z')).toContain('–');
    });
});

describe('upcomingMeta — deelnemers', () => {
    it('telt deelnemers plus de organisator en noemt een lege lijst ONBEKEND, nooit 0', () => {
        expect(attendeeCountOf(talkMeeting())).toBe(3);                              // 2 deelnemers + organisator
        expect(attendeeCountOf({ attendees: [{ email: 'me@e.nl', self: true }, { email: 'ines@e.nl' }], organizerEmail: 'me@e.nl' })).toBe(2);
        // Ad-hoc Talk-room zonder agenda-afspraak: de lijst is leeg, niet nul.
        expect(attendeeCountOf(talkMeeting({ attendees: [], organizer: null }))).toBeNull();
        expect(attendeeCountOf(talkMeeting({ attendees: undefined, organizer: null }))).toBeNull();
        // Een deelnemer zonder naam of adres is nog steeds een deelnemer.
        expect(attendeeCountOf({ attendees: [{}, {}] })).toBe(2);
        // Dubbele adressen zijn één mens.
        expect(attendeeCountOf({ attendees: [{ email: 'A@e.nl' }, { email: 'a@e.nl' }] })).toBe(1);
    });

    it('een expliciete telling uit de payload wint; een 0 of een string daaruit is onbekend', () => {
        expect(attendeeCountOf({ participantCount: 7, attendees: [{ email: 'a@b.c' }] })).toBe(7);
        expect(attendeeCountOf({ participantCount: 0, attendees: [{ email: 'a@b.c' }] })).toBeNull();
        expect(attendeeCountOf({ participantCount: '3', attendees: [{ email: 'a@b.c' }] })).toBeNull();
        expect(attendeeCountOf({ participantCount: Infinity })).toBeNull();
        expect(attendeeCountOf(null)).toBeNull();
    });
});

describe('upcomingMeta — de metaregel', () => {
    it('is tijd · duur · deelnemers, met de meervoudsvorm op de sleutel', () => {
        const many = metaSegments(talkMeeting(), t).map(s => s.text);
        expect(many).toContain('30 min');
        expect(many).toContain('3 participants');

        const one = metaSegments({ attendees: [], organizer: { cn: 'Sanne', email: 's@e.nl' } }, t).map(s => s.text);
        expect(one).toContain('1 participant');
        expect(one).not.toContain('1 participants');
    });

    it('laat een onbekende duur weg en zegt van deelnemers hardop dat ze onbekend zijn', () => {
        const segs = metaSegments({ start: '2026-07-18T09:00:00Z', end: null, attendees: [] }, t);
        expect(segs.map(s => s.key)).toEqual(['time', 'attendees']);          // geen duur-stuk
        const attendees = segs.find(s => s.key === 'attendees');
        expect(attendees.text).toBe('participants unknown');
        expect(attendees.title).toBe("This calendar invite doesn't list who is coming.");
    });

    it('een hele dag zegt "All day" en heeft geen duur', () => {
        const segs = metaSegments({ start: '2026-07-18', end: '2026-07-19', attendees: [{ email: 'a@e.nl' }] }, t);
        expect(segs.map(s => s.text)).toEqual(['All day', '1 participant']);
    });

    it('zonder begintijd staat er geen tijd — geen verzonnen moment', () => {
        expect(metaSegments({ start: null, end: null, attendees: [{ email: 'a@e.nl' }] }, t).map(s => s.key))
            .toEqual(['attendees']);
    });
});

describe('upcomingMeta — waarom de toggle uit staat', () => {
    it('legt alleen uit wat de server als reden meestuurde', () => {
        expect(recordReasonHint('small_meeting', false, t)).toBe('Off by default: this looks like a one-on-one.');
        expect(recordReasonHint('unknown_size', false, t)).toBe("Off by default: the calendar doesn't say who is coming.");
        expect(recordReasonHint('opted_out', false, t)).toBeUndefined();      // een eigen keuze hoeft geen uitleg
        expect(recordReasonHint(undefined, false, t)).toBeUndefined();
        expect(recordReasonHint('small_meeting', true, t)).toBeUndefined();   // hij staat aan
    });
});

describe('upcomingMeta — de voetregel belooft alleen wat de bot echt doet', () => {
    const talkRows = [{ provider: 'talk', status: 'will_record', m: { excluded: false } }];

    it('claimt, ontkent of zwijgt over de Talk-write-back', () => {
        expect(attendeeNotices({ rows: talkRows, postSummaryBack: true })).toEqual([NOTICE_TALK_POST]);
        expect(attendeeNotices({ rows: talkRows, postSummaryBack: false })).toEqual([NOTICE_TALK_QUIET]);
        // Het veld ontbreekt in de payload → onbekend → geen zin over Talk.
        expect(attendeeNotices({ rows: talkRows, postSummaryBack: undefined })).toEqual([]);
        expect(attendeeNotices({ rows: talkRows })).toEqual([]);
        expect(attendeeNotices({ rows: talkRows, postSummaryBack: 'ja' })).toEqual([]);
    });

    it('belooft ook mét write-back geen MELDING — het bericht is silent', () => {
        expect(NOTICE_TALK_POST.en).toContain('nobody gets a notification');
        expect(NOTICE_TALK_POST.en).not.toMatch(/participants (get|are) notified/i);
    });

    it('Teams: the sharing line for any note-producing row, the auto-record line only when armed', () => {
        const rows = [{ provider: 'teams', status: 'will_record', m: { organizerSelf: true } }];
        expect(attendeeNotices({ rows })).toEqual([NOTICE_TEAMS_SHARE]);
        expect(attendeeNotices({ rows, teamsAutoRecordArmed: true })).toEqual([NOTICE_TEAMS_SHARE, NOTICE_TEAMS_AUTORECORD]);
        // "Record in Teams" still produces a note, an "Organizer only" row does not.
        expect(attendeeNotices({ rows: [{ provider: 'teams', status: 'manual_record_teams', m: {} }] })).toEqual([NOTICE_TEAMS_SHARE]);
        expect(attendeeNotices({ rows: [{ provider: 'teams', status: 'not_organizer', m: {} }], teamsAutoRecordArmed: true })).toEqual([]);
        expect(NOTICE_TEAMS_SHARE.en).toContain('does not notify them');
    });

    it('de Meet-zin gaat over leesrecht, nooit over een melding van ONS', () => {
        expect(attendeeNotices({ rows: [{ provider: 'gmeet', status: 'will_import', m: { excluded: false } }] }))
            .toEqual([NOTICE_MEET_SHARE]);
        expect(NOTICE_MEET_SHARE.en).toContain('does not notify them');
    });

    it('DE STAND VAN DE SCHAKELAAR IS NIET DE UITKOMST', () => {
        // `!excluded` betekende "de toggle staat aan", niet "er komt een
        // notitie": de route rekent `excluded` met `fallback: true` en heeft
        // voor `will_record` óók de globale schakelaar, de opnameback-end en
        // het moderatorschap nodig. Zo stond de belofte "de samenvatting wordt
        // teruggepost" onder een lijst waar de banner erboven meldde dat de
        // opnameback-end niet eens geconfigureerd is.
        const notRecording = [
            { provider: 'talk', status: 'upcoming', m: { excluded: false } },
            { provider: 'talk', status: 'not_moderator', m: { excluded: false } },
            { provider: 'talk', status: 'decides_at_start', m: { excluded: false } },
            { provider: 'gmeet', status: 'upcoming', m: { excluded: false } },
        ];
        expect(attendeeNotices({ rows: notRecording, postSummaryBack: true })).toEqual([]);
        // Een lopende opname telt wél.
        expect(attendeeNotices({ rows: [{ provider: 'talk', status: 'recording_now', m: {} }], postSummaryBack: true }))
            .toEqual([NOTICE_TALK_POST]);
    });

    it('waarschuwt dat DEZE knop Meets eigen opnamemelding kan aanzetten', () => {
        // De zin eindigde op "not notified" terwijl dezelfde toggle
        // `autoRecordingGeneration: 'ON'` kan zetten — en Meet kondigt een
        // lopende opname altijd aan bij alle deelnemers.
        const organiser = [{ provider: 'gmeet', status: 'will_import', m: { organizerSelf: true } }];
        expect(attendeeNotices({ rows: organiser, meetAutoRecordArmed: true }))
            .toEqual([NOTICE_MEET_SHARE, NOTICE_MEET_AUTORECORD]);
        // Alleen als de knop hem ook echt kan zetten.
        expect(attendeeNotices({ rows: organiser, meetAutoRecordArmed: false })).toEqual([NOTICE_MEET_SHARE]);
        // En alleen voor een vergadering die de lezer ORGANISEERT: bij een
        // gast doet setAutoRecording niets (`not_host`).
        const guest = [{ provider: 'gmeet', status: 'manual_record', m: { organizerSelf: false } }];
        expect(attendeeNotices({ rows: guest, meetAutoRecordArmed: true })).toEqual([NOTICE_MEET_SHARE]);
    });

    it('zegt niets over vergaderingen die niet worden opgenomen', () => {
        expect(attendeeNotices({
            rows: [
                { provider: 'talk', status: 'upcoming', m: { excluded: true } },
                { provider: 'gmeet', status: 'excluded', m: { excluded: true } },
            ],
            postSummaryBack: true,
        })).toEqual([]);
        expect(attendeeNotices({ rows: [], postSummaryBack: true })).toEqual([]);
        expect(attendeeNotices()).toEqual([]);
    });
});

describe('upcomingMeta — onbeslist is geen "uit"', () => {
    it('zegt bij recordDecided=false dat er nog geteld wordt', () => {
        const hint = recordReasonHint('unknown_size', false, t, { recordDecided: false });
        expect(hint).toContain('counts who is in the call when it starts');
        // En de reden-zin van "uit" komt er dan NIET bij.
        expect(hint).not.toContain('Off by default');
    });

    it('legt `opted_out` alleen uit als het NIET de eigen keuze was', () => {
        expect(recordReasonHint('opted_out', false, t)).toBeUndefined();
        expect(recordReasonHint('opted_out', false, t, { overridden: true }))
            .toContain('Kept off by a wider rule');
    });

    it('het woord onder de toggle beweert niets wat nog niet vaststaat', () => {
        expect(toggleStateLabel(true, false, t)).toBe('Record');
        expect(toggleStateLabel(false, false, t)).toBe('Decides at start');
        expect(toggleStateLabel(false, true, t)).toBe('Skip');
        expect(toggleStateLabel(false, undefined, t)).toBe('Skip');
    });
});

describe('upcomingMeta — tags', () => {
    it('houdt alleen echte strings over', () => {
        expect(meetingTags({ tags: ['a', ' b ', 3, null, ''] })).toEqual(['a', 'b']);
        expect(meetingTags({})).toEqual([]);
        expect(meetingTags({ tags: 'a,b' })).toEqual([]);
        expect(meetingTags(null)).toEqual([]);
    });
});

