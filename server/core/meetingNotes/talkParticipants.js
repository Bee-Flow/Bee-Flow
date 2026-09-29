// @typecheck
'use strict';

/**
 * Hoeveel mensen doen er mee aan een Talk-vergadering — de bronnen die de
 * Gepland-LIJST en de opname-ENGINE allebei hebben.
 *
 * ── WAAROM DIT EEN GEDEELDE MODULE IS ────────────────────────────────
 * De lijst en de engine namen dezelfde beslissing met ANDERE gegevens. De
 * route rekende alleen met de agenda (`participantCountOf(m)`); de engine had
 * die agenda PLUS het conversatietype PLUS een live telling bij Talk. Bij een
 * agenda-afspraak zonder ATTENDEE-regels — de gewone "Talk-ruimte met een
 * gedeelde link"-vorm — zei de route `unknown_size` → toggle UIT, terwijl de
 * engine er vier deelnemers telde en OPNAM. Het scherm zei het tegenovergestelde
 * van wat de server deed, in een privacyproduct. Deze module is de helft die
 * BEIDE kanten kunnen weten; wat alleen de engine kan weten (de live telling)
 * staat er expliciet buiten, en dat verschil draagt de route als
 * `recordDecided: false` naar het scherm in plaats van als een stille "uit".
 *
 * ── DE SCOPE BEPAALT OF DE AGENDA MEETELT ────────────────────────────
 * Bij `autoRecordScope: 'all'` kijkt de engine niet naar de agenda
 * (talkAutoRecord vult `calendarByToken` alleen in calendar-scope). Een
 * uitnodiging met zes genodigden zou dan "Will record" op het scherm zetten
 * terwijl de engine op de live telling beslist. Dus: in scope 'all' telt de
 * agenda hier ook niet mee.
 *
 * ── ONBEKEND VERSMALT ────────────────────────────────────────────────
 * `null` is "we weten het niet", nooit "nul". `decideRecord` maakt daar
 * `record: false, reason: 'unknown_size'` van — onbekend telt niet als "meer
 * dan twee".
 */

/**
 * Het deelnemersaantal dat ZONDER een extra Talk-aanroep vast te stellen is.
 *
 * @param {object} p
 * @param {object|null} p.room      een rij uit `nextcloud_talk_list_rooms`
 * @param {object|null} p.meeting   de agenda-afspraak (talkCalendar), of null
 * @param {string} p.autoRecordScope 'calendar' | 'all'
 * @returns {number|null} het aantal, of null als het van hieruit niet te weten is
 */
function knownParticipantCount({ room = null, meeting = null, autoRecordScope = 'calendar' } = /** @type {any} */ ({})) {
    const meetingPrefs = require('../../stores/meetingPrefsStore');

    // 1. De agenda — maar alleen als de engine er ook naar kijkt.
    if (autoRecordScope !== 'all') {
        const fromCalendar = meetingPrefs.participantCountOf(meeting);
        if (fromCalendar !== null) return fromCalendar;
    }

    // 2. Het conversatietype. Een Talk-room van type 1 is per definitie een
    //    één-op-één; dat weet de route net zo goed als de engine, want beide
    //    hebben de kamerlijst al in handen.
    if (room && room.type === 1) return 2;

    return null;
}

module.exports = { knownParticipantCount };
