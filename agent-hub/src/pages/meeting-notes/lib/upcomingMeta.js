/**
 * De metaregel van een Gepland-rij: `tijd · duur · deelnemers` (de provider
 * staat als chip achter die stukken), plus de voetregel over wat er met de
 * ANDERE deelnemers gebeurt. Pure functies, zodat de regels waar het hier om
 * gaat los van de DOM te toetsen zijn.
 *
 * ── WAT WE NIET WETEN, ZEGGEN WE NIET ─────────────────────────────────
 * Geen enkele provider levert een DUUR (gmeetCalendar.js:29-49 en
 * talkCalendar.js:66-75 geven alleen start/end), dus die wordt hier uit
 * `end - start` afgeleid. Ontbreekt `end`, of is de afspraak een hele dag (een
 * DATUM zonder tijd), dan is de duur ONBEKEND en staat er niets — geen "0 min".
 * Hetzelfde voor deelnemers: Talk leest ze uit de ICS-ATTENDEE-property
 * (nextcloudCalendarTools.js:205-208) en een ad-hoc room zonder agenda-afspraak
 * levert een LEGE lijst; leeg is "de agenda vertelde ons niets", niet "nul
 * mensen". Een nul die eigenlijk onbekend is, was in dit programma al drie keer
 * een bevinding.
 */

import { nOf } from '../../../components/admin/Studio/KnowledgeStudio/plural';
import { parseWhen, meetingDurationMinutes, dateBlockParts, timeRange } from './upcomingWhen';

// De datumregels staan in een IMPORTLOZE buurmodule, zodat de hele-dag-fix in
// een kindproces onder een negatieve tijdzone getoetst kan worden — in UTC
// geven de goede en de foute implementatie hetzelfde antwoord. Hier
// her-geëxporteerd zodat aanroepers en tests niets merken.
export { parseWhen, meetingDurationMinutes, dateBlockParts, timeRange };

/**
 * Het aantal deelnemers, of NULL als de agenda er niets over zei.
 *
 * Dit spiegelt `meetingPrefsStore.participantCountOf` (server) — dezelfde
 * telling, want de server beslist er de 1-op-1-standaard mee en een rij die
 * "4 participants" toont terwijl de server met 5 rekende, verklaart de stand
 * van de toggle niet. De server-module is CommonJS in `server/` en dus niet
 * importeerbaar in de SPA; komt er ooit een `participantCount` in de payload,
 * dan wint die (en is deze afleiding alleen nog de terugval).
 *
 * Een LEGE deelnemerslijst levert NULL: dat is "de agenda vertelde ons niets".
 * Een 0 uit de payload is om dezelfde reden onbekend, niet nul mensen.
 */
function identityOf(entry) {
    if (entry && typeof entry === 'object') return entry.email || entry.cn || entry.displayName || entry.name || null;
    return typeof entry === 'string' ? entry : null;
}

function organizerIdentityOf(meeting) {
    if (meeting.organizerEmail) return meeting.organizerEmail;          // Meet
    const organizer = meeting.organizer;                                 // Talk (ICS ORGANIZER)
    if (organizer && typeof organizer === 'object') return organizer.email || organizer.cn || null;
    return typeof organizer === 'string' ? organizer : null;
}

export function attendeeCountOf(meeting) {
    if (!meeting || typeof meeting !== 'object') return null;

    const explicit = meeting.participantCount;
    if (explicit !== undefined && explicit !== null) {
        if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 0) return null;
        const n = Math.floor(explicit);
        return n > 0 ? n : null;
    }

    if (!Array.isArray(meeting.attendees)) return null;
    const ids = new Set();
    let anon = 0;
    for (const entry of meeting.attendees) {
        const ident = identityOf(entry);
        if (ident) ids.add(String(ident).trim().toLowerCase());
        else anon += 1;   // een deelnemer zonder naam is nog steeds een deelnemer
    }
    const organizer = organizerIdentityOf(meeting);
    if (organizer) ids.add(String(organizer).trim().toLowerCase());

    const total = ids.size + anon;
    return total > 0 ? total : null;
}

/** De tags van deze vergadering (meeting_prefs). Alles wat geen tekst is valt weg. */
export function meetingTags(m) {
    return (Array.isArray(m?.tags) ? m.tags : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

/** '30 min' / '2 hr' / '1 hr 30 min'; '' als de duur onbekend is. */
export function durationPhrase(minutes, t) {
    if (minutes == null) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return t('meetings.upcoming_duration_hm', '{hours} hr {minutes} min', { hours: h, minutes: m });
    if (h) return t('meetings.upcoming_duration_h', '{count} hr', { count: h });
    return t('meetings.upcoming_duration_m', '{count} min', { count: m });
}

/**
 * De stukken van de metaregel: tijd · duur · deelnemers.
 *
 * Een stuk dat we niet weten, staat er NIET. De enige uitzondering is het
 * aantal deelnemers: dat wordt "participants unknown", want het is precies de
 * reden dat de toggle standaard uit staat (`recordReason: 'unknown_size'`) en
 * een lege plek zou die stand onverklaard laten.
 *
 * `nOf` zet de ternary om de SLEUTEL heen (basis + `_plural`), nooit een
 * "participant(s)" in de zin.
 */
export function metaSegments(m, t) {
    const out = [];
    const when = parseWhen(m?.start);
    if (when && when.dateOnly) out.push({ key: 'time', text: t('meetings.upcoming_all_day', 'All day') });
    else {
        const range = timeRange(m?.start, m?.end);
        if (range) out.push({ key: 'time', text: range });
    }

    const duration = durationPhrase(meetingDurationMinutes(m?.start, m?.end), t);
    if (duration) out.push({ key: 'duration', text: duration });

    const count = attendeeCountOf(m);
    out.push(count === null
        ? {
            key: 'attendees',
            text: t('meetings.upcoming_attendees_unknown', 'participants unknown'),
            title: t('meetings.upcoming_attendees_unknown_hint', "This calendar invite doesn't list who is coming."),
            dim: true,
        }
        : { key: 'attendees', text: nOf(t, 'meetings.upcoming_attendees', count, '{count} participant', '{count} participants') });

    return out;
}

/**
 * Waarom staat deze toggle uit? Alleen als de server een reden meestuurde.
 *
 * `recordDecided === false` betekent: de server gaat er nog naar kijken (Talk
 * telt bij de start van het gesprek wie er echt in zit). Dan is "staat uit" de
 * verkeerde zin — die stand is nog niet genomen.
 *
 * `opted_out` krijgt een uitleg zodra de keuze NIET van de lezer zelf kwam
 * (`overridden`): een org-brede uitsluiting, of de serie-rij naast de
 * occurrence. Zonder dat onderscheid zag een gebruiker zijn eigen klik
 * terugspringen zonder één woord waarom.
 */
export function recordReasonHint(reason, record, t, opts = {}) {
    const { recordDecided, overridden } = opts;
    if (record) return undefined;
    if (recordDecided === false) {
        return t('meetings.upcoming_undecided_hint', 'Not decided yet: Bee Flow counts who is in the call when it starts. Switch this on to record it either way.');
    }
    if (!reason) return undefined;
    if (reason === 'opted_out') {
        return overridden
            ? t('meetings.upcoming_off_by_admin', "Kept off by a wider rule — your organisation, or the whole recurring series. Your own switch can't override it.")
            : undefined;
    }
    if (reason === 'small_meeting') return t('meetings.upcoming_off_one_on_one', 'Off by default: this looks like a one-on-one.');
    if (reason === 'unknown_size') return t('meetings.upcoming_off_unknown_size', "Off by default: the calendar doesn't say who is coming.");
    return undefined;
}

/**
 * Het woord onder de toggle. "Skip" is een BEWERING dat er niets gebeurt; bij
 * een nog niet genomen beslissing is dat onwaar.
 */
export function toggleStateLabel(record, recordDecided, t) {
    if (record) return t('meetings.upcoming_record', 'Record');
    // Dezelfde sleutel als de statuschip: één woord, één vertaling.
    if (recordDecided === false) return t('meetings.upcoming_decides', 'Decides at start');
    return t('meetings.upcoming_skip', 'Skip');
}

/**
 * Wat er met de ANDERE deelnemers gebeurt, en alleen wat waar is.
 *
 * Claim / ontken / zwijg:
 *   - Talk post de samenvatting alleen terug als `postSummaryBack` aan staat
 *     (default UIT, talkNotesSettings.js) — en dan nog met `silent: true`
 *     (ingestNextcloudRecording.js), dus het bericht staat in het gesprek
 *     zónder melding. "Deelnemers krijgen een melding" is daar dus óók niet
 *     waar; de zin zegt wat er echt gebeurt.
 *   - Staat `postSummaryBack` op false, dan mogen we dat ontkennen.
 *   - Zegt de payload er NIETS over (het veld ontbreekt), dan zwijgen we:
 *     onbekend is geen belofte en ook geen ontkenning.
 *   - Meet meldt zelf niets over de NOTITIE, maar deelt wél leesrecht met
 *     deelnemers die een eigen Bee Flow-account op hetzelfde Google-adres
 *     hebben (ingestGmeetRecording.js → resolveSharedWith). Leesrecht is geen
 *     melding — dat verschil staat in de zin.
 *
 * ── DE OPNAMEMELDING VAN GOOGLE MEET ZELF ─────────────────────────────
 * De Meet-zin eindigde op "They are not notified", terwijl DEZELFDE toggle
 * Google Meets EIGEN auto-opname kan aanzetten: bij `record: true` met een
 * meetingCode roept de PATCH `setAutoRecording(...)` aan, wat `spaces.patch`
 * doet met `autoRecordingGeneration: 'ON'` (gmeetArtifacts.js). Meet kondigt
 * een lopende opname ALTIJD aan bij alle deelnemers. Die zin ontkende dus een
 * melding die de knop eronder juist veroorzaakt.
 * Vandaar de tweede Meet-regel, en alleen wanneer hij echt van toepassing is:
 * de org/gebruiker heeft `autoRecordConfig` aan, de Google-koppeling heeft de
 * settings-scope, en de lezer organiseert minstens één van de rijen die
 * daadwerkelijk geïmporteerd worden. Bij Talk staat de opnamemelding er
 * bewust NIET: die zet Nextcloud Talk zelf, op de server van de klant — dat is
 * gedrag van een ander product, geen belofte van ons. Hier zet Bee Flow de
 * vlag zélf, vanuit deze knop, dus hier is het wél onze uitspraak.
 *
 * ── ALLEEN OVER RIJEN DIE ECHT EEN NOTITIE OPLEVEREN ──────────────────
 * `!excluded` is de stand van de SCHAKELAAR, niet de uitkomst: de route rekent
 * hem met `fallback: true` en heeft voor `will_record` óók de globale
 * schakelaar, de opnameback-end en het moderatorschap nodig (Meet: `autoImport`
 * plus de scopes). Op `!excluded` afgaan zette de belofte "de samenvatting
 * wordt teruggepost" onder een lijst waar de banner erboven meldde dat de
 * opname-back-end helemaal niet geconfigureerd is. Daarom telt hier de
 * STATUS die de rij zelf al draagt.
 */
export const NOTICE_TALK_POST = Object.freeze({
    key: 'meetings.upcoming_notice_talk_post',
    en: 'Nextcloud Talk: the summary is posted back into the conversation afterwards, as a silent message — nobody gets a notification.',
});
export const NOTICE_TALK_QUIET = Object.freeze({
    key: 'meetings.upcoming_notice_talk_quiet',
    en: 'Nextcloud Talk: Bee Flow posts nothing back into the conversation, so the other participants never hear about the note from us.',
});
export const NOTICE_MEET_SHARE = Object.freeze({
    key: 'meetings.upcoming_notice_meet_share',
    en: 'Google Meet: participants who have a Bee Flow account on the same Google address can read the note afterwards. Bee Flow does not notify them.',
});
export const NOTICE_MEET_AUTORECORD = Object.freeze({
    key: 'meetings.upcoming_notice_meet_autorecord',
    en: 'Google Meet: switching a meeting you organise on also turns on Meet’s own auto-recording, and Meet announces a running recording to everyone in the call.',
});

export const NOTICE_TEAMS_SHARE = Object.freeze({
    key: 'meetings.upcoming_notice_teams_share',
    en: 'Microsoft Teams: colleagues in your organisation who were invited can read the note afterwards. Bee Flow does not notify them.',
});
export const NOTICE_TEAMS_AUTORECORD = Object.freeze({
    key: 'meetings.upcoming_notice_teams_autorecord',
    en: 'Microsoft Teams: switching a meeting you organise on also turns on Teams’ own automatic recording, and Teams shows everyone in the call that it is being recorded.',
});

/** De statussen waarin er werkelijk een notitie uit deze rij gaat komen. */
const PRODUCES_NOTE = new Set(['will_record', 'recording_now', 'will_import', 'manual_record', 'manual_record_teams']);

export function producesNote(row) {
    return PRODUCES_NOTE.has(row?.status);
}

/**
 * @param {object} p
 * @param {Array} p.rows            [{ provider, m, status }] — `status` is de
 *                                  EFFECTIEVE chipstatus van de rij, niet `!excluded`.
 * @param {boolean|undefined} p.postSummaryBack  undefined = de payload zei niets
 * @param {boolean} p.meetAutoRecordArmed  Meets eigen auto-opname kan door deze
 *                                  knop worden aangezet (autoRecordConfig aan,
 *                                  settings-scope aanwezig)
 * @param {boolean} [p.teamsAutoRecordArmed]  same for Teams' "record automatically"
 *                                  (autoRecordConfig on, OnlineMeetings.ReadWrite granted)
 */
export function attendeeNotices({ rows = [], postSummaryBack, meetAutoRecordArmed = false, teamsAutoRecordArmed = false } = {}) {
    const on = (provider) => rows.some(r => r && r.provider === provider && producesNote(r));
    const notices = [];
    if (on('talk')) {
        if (postSummaryBack === true) notices.push(NOTICE_TALK_POST);
        else if (postSummaryBack === false) notices.push(NOTICE_TALK_QUIET);
        // undefined → de payload zei het niet; dan zeggen wij het ook niet.
    }
    if (on('gmeet')) {
        notices.push(NOTICE_MEET_SHARE);
        // Alleen als de knop die melding ook echt kan veroorzaken: de vlag
        // wordt uitsluitend gezet voor een vergadering die de lezer ORGANISEERT.
        const organises = rows.some(r => r && r.provider === 'gmeet' && producesNote(r) && r.m?.organizerSelf === true);
        if (meetAutoRecordArmed && organises) notices.push(NOTICE_MEET_AUTORECORD);
    }
    // Teams rows only produce a note for meetings the reader organises, so the
    // auto-record line needs no extra organiser check.
    if (on('teams')) {
        notices.push(NOTICE_TEAMS_SHARE);
        if (teamsAutoRecordArmed) notices.push(NOTICE_TEAMS_AUTORECORD);
    }
    return notices;
}
