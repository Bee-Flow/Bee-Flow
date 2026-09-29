/**
 * Talk auto-record × meeting_prefs (M5).
 *
 * Dit is de plek waar een opname daadwerkelijk START. Wat hier fout gaat, is
 * geen verkeerd label in een lijstje maar een gesprek dat wordt opgenomen
 * terwijl iemand dat had uitgezet. Vastgelegd:
 *   - de voorkeuren worden geladen met de scope van DEZE gebruiker;
 *   - een uitsluiting (ruimte of occurrence) stopt de opname;
 *   - de 1-op-1-standaard: een Talk-conversatie van type 1 is per definitie
 *     twee mensen en wordt niet vanzelf opgenomen; een expliciete keuze wint;
 *   - een groepsruimte zonder agenda-afspraak wordt niet als "onbekend"
 *     weggegooid maar bij Talk NAGEVRAAGD — en als dat niet lukt, blijft het
 *     onbekend en wordt er dus niet opgenomen.
 *
 * Alle afhankelijkheden zijn gestubd via de Module-resolve-hook; geen database,
 * geen Nextcloud.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/talkAutoRecord.prefs.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {};

function resetFx() {
    fx.settings = { autoRecord: true, autoRecordScope: 'all', recordingMode: 'audio' };
    fx.rooms = [];
    fx.meetings = [];
    fx.participants = {};      // token → { participants: [...] } | { error }
    fx.prefs = {};             // 'kind:id' → true | false
    fx.prefLoads = [];
    fx.started = [];
    fx.config = { user_talk_notes_u1: {} };
    fx.talkCalls = [];
}
resetFx();

const MOCKS = {
    '../../stores/configStore': {
        getConfig: async (k) => (k in fx.config ? fx.config[k] : null),
        setConfig: async (k, v) => { fx.config[k] = v; },
        getAllConfig: async () => ({ ...fx.config }),
    },
    './talkNotesSettings': {
        resolveTalkNotesSettings: async () => ({ ...fx.settings }),
    },
    '../../stores/userStore': {
        getUser: async () => ({ id: 'u1', organizationId: 'orgA' }),
        getAllUsers: async () => [{ id: 'u1', organizationId: 'orgA' }],
    },
    '../../automation/triggerBus': {
        loadSession: async () => ({ user: { id: 'u1' }, accessToken: 'nc' }),
    },
    '../../integrations/nextcloudTalkTools': {
        getTalkRecordingCapability: async () => ({ recordingEnabled: true }),
        executeNextcloudTalkTool: async (name, args) => {
            fx.talkCalls.push({ name, args });
            if (name === 'nextcloud_talk_list_rooms') return { rooms: fx.rooms };
            if (name === 'nextcloud_talk_list_participants') {
                const p = fx.participants[args.token];
                if (!p) return { error: 'room_not_found' };
                return { token: args.token, count: (p.participants || []).length, ...p };
            }
            if (name === 'nextcloud_talk_start_recording') { fx.started.push(args); return { success: true }; }
            return { error: 'unexpected tool' };
        },
    },
    '../integrations/ncScopeGuard': {
        guardedNcCall: async (_tool, _args, _ctx, call) => call(),
    },
    './talkCalendar': {
        listUpcomingTalkMeetings: async () => fx.meetings,
    },
    // meeting_prefs — de beslislogica zelf ligt vast in
    // stores/meetingPrefsStore.test.js.
    '../../stores/meetingPrefsStore': {
        talkIds: ({ eventUid = null, roomToken = null } = {}) => [
            { kind: 'event', id: eventUid }, { kind: 'room', id: roomToken },
        ].filter((x) => typeof x.id === 'string' && x.id),
        participantCountOf: (m) => {
            if (!m || !Array.isArray(m.attendees)) return null;
            const ids = new Set(m.attendees.map((a) => String(a?.email || a?.cn || '').toLowerCase()).filter(Boolean));
            const org = m.organizer && (m.organizer.email || m.organizer.cn);
            if (org) ids.add(String(org).toLowerCase());
            return ids.size || null;
        },
        loadMeetingPrefs: async ({ provider, userId, orgId }) => {
            fx.prefLoads.push({ provider, userId, orgId });
            const opinionFor = (ids) => {
                if (ids.some(({ kind, id }) => fx.prefs[`${kind}:${id}`] === false)) return false;
                if (ids.some(({ kind, id }) => fx.prefs[`${kind}:${id}`] === true)) return true;
                return null;
            };
            return {
                opinionFor,
                tagsFor: () => [],
                decide: ({ ids, participantCount = null, fallback = false }) => {
                    const o = opinionFor(ids);
                    if (o !== null) return { record: o, reason: o ? 'opted_in' : 'opted_out' };
                    if (!(typeof participantCount === 'number' && participantCount > 2)) {
                        return { record: false, reason: participantCount === null ? 'unknown_size' : 'small_meeting' };
                    }
                    return fallback ? { record: true, reason: 'auto' } : { record: false, reason: 'auto_off' };
                },
            };
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:talkautorecord:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
// De module onder test bestaat uit TWEE bestanden: talkAutoRecord.js en de
// gedeelde deelnemersteller talkParticipants.js. Beide moeten door de hook,
// en niet alleen omdat de tweede zijn eigen requires heeft: ze wonen in
// DEZELFDE map, en Node's `relativeResolveCache` is gesleuteld op
// `${parent.path}\0${request}`. Staat er maar één in de hook, dan bepaalt de
// TOEVALLIGE volgorde welk van de twee `../../stores/meetingPrefsStore` het
// eerst oplost — en het antwoord van die ene komt daarna ook bij de ander
// terecht, mock of echt.
const MOCK_PARENTS = /meetingNotes[\\/](talkAutoRecord|talkParticipants)\.js$/;
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && MOCK_PARENTS.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { scanAndRecord } = require('./talkAutoRecord');

test.after(() => { Module._resolveFilename = originalResolve; });

/** Een actieve call die deze gebruiker modereert en nog niet opneemt. */
function activeRoom(token, overrides = {}) {
    return { token, type: 2, participantType: 2, hasCall: true, callRecording: 0, objectType: '', ...overrides };
}

test('de voorkeuren worden met de scope van deze gebruiker geladen', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-scope')];
    fx.participants['t-scope'] = { participants: [{ inCall: 1 }, { inCall: 1 }, { inCall: 1 }] };
    await scanAndRecord();
    assert.deepEqual(fx.prefLoads, [{ provider: 'talk', userId: 'u1', orgId: 'orgA' }]);
});

test('een uitgesloten ruimte wordt NIET opgenomen, hoe vol de call ook is', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-uit')];
    fx.participants['t-uit'] = { participants: [{ inCall: 1 }, { inCall: 1 }, { inCall: 1 }, { inCall: 1 }] };
    fx.prefs['room:t-uit'] = false;
    await scanAndRecord();
    assert.deepEqual(fx.started, [], 'wie opnemen uitzette, blijft uit');
});

test('een groepscall van meer dan twee wordt wél opgenomen', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-groep')];
    fx.participants['t-groep'] = { participants: [{ inCall: 1 }, { inCall: 1 }, { inCall: 1 }] };
    await scanAndRecord();
    assert.deepEqual(fx.started, [{ token: 't-groep', status: 2 }]);
});

test('1-op-1 (Talk-conversatie van type 1) wordt standaard NIET opgenomen', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-1op1', { type: 1 })];
    await scanAndRecord();
    assert.deepEqual(fx.started, []);
    assert.equal(fx.talkCalls.some(c => c.name === 'nextcloud_talk_list_participants'), false,
        'type 1 is per definitie twee mensen — daar hoeft niets voor opgevraagd te worden');
});

test('een expliciete keuze wint van de 1-op-1-standaard', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-1op1-ja', { type: 1 })];
    fx.prefs['room:t-1op1-ja'] = true;
    await scanAndRecord();
    assert.deepEqual(fx.started, [{ token: 't-1op1-ja', status: 2 }]);
});

test('alleen wie IN de call zit telt mee, niet de hele conversatieledenlijst', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-halfleeg')];
    fx.participants['t-halfleeg'] = {
        participants: [{ inCall: 1 }, { inCall: 3 }, { inCall: 0 }, { inCall: 0 }, { inCall: 0 }],
    };
    await scanAndRecord();
    assert.deepEqual(fx.started, [], 'vijf leden, twee in gesprek — dat is een 1-op-1');
});

test('lukt het opvragen niet, dan blijft het aantal ONBEKEND en wordt er niet opgenomen', async () => {
    resetFx();
    fx.rooms = [activeRoom('t-onbekend')];
    // geen fx.participants-entry → { error: 'room_not_found' }
    await scanAndRecord();
    assert.deepEqual(fx.started, [], 'onbekend versmalt; het telt niet als "meer dan twee"');
});

test('calendar-scope: de deelnemers uit de agenda-afspraak beslissen, en de occurrence telt mee', async () => {
    resetFx();
    fx.settings.autoRecordScope = 'calendar';
    fx.rooms = [activeRoom('t-cal'), activeRoom('t-cal2')];
    fx.meetings = [
        {
            uid: 'uid-cal', talkToken: 't-cal', organizer: { email: 'tom@x.nl' },
            attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }],
        },
        {
            uid: 'uid-cal2', talkToken: 't-cal2', organizer: { email: 'tom@x.nl' },
            attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }],
        },
    ];
    fx.prefs['event:uid-cal2'] = false;   // deze occurrence is uitgezet

    await scanAndRecord();
    assert.deepEqual(fx.started, [{ token: 't-cal', status: 2 }]);
    assert.equal(fx.talkCalls.some(c => c.name === 'nextcloud_talk_list_participants'), false,
        'de agenda wist het al — geen extra Talk-aanroep');
});

test('NIEMAND in gesprek is ONBEKEND, niet het ledental van de conversatie', async () => {
    resetFx();
    // Een groepsconversatie met vijf LEDEN waarvan niemand de inCall-bit
    // draagt. De oude terugval las dan `res.count` — `participants.length` uit
    // de tool, oftewel iedereen die ooit aan de conversatie is toegevoegd — en
    // begon op te nemen. Dat gebeurt in productie echt: de kamerlijst wordt één
    // keer bovenaan de scan opgehaald en een gesprek dat intussen eindigde
    // levert overal inCall 0.
    fx.rooms = [activeRoom('t-nul')];
    fx.participants['t-nul'] = { participants: [{ inCall: 0 }, { inCall: 0 }, { inCall: 0 }, { inCall: 0 }, { inCall: 0 }] };
    await scanAndRecord();
    assert.deepEqual(fx.started, [], 'onbekend versmalt — vijf leden zijn geen vijf deelnemers');
});

test('een deelnemersvorm zonder inCall-veld telt ook als onbekend', async () => {
    resetFx();
    // `Number(undefined) || 0` doet hetzelfde als een expliciete nul; een oudere
    // of afwijkende Talk-versie mag geen opname starten op grond van niets.
    fx.rooms = [activeRoom('t-geen-veld')];
    fx.participants['t-geen-veld'] = { participants: [{}, {}, {}, {}] };
    await scanAndRecord();
    assert.deepEqual(fx.started, []);
});

test('scope "all": de agenda telt niet mee, ook niet als hij er is', async () => {
    resetFx();
    // De engine vult `calendarByToken` alleen in calendar-scope. De Gepland-
    // lijst gebruikt daarom dezelfde regel (knownParticipantCount), zodat de
    // twee niet elk een ander getal gebruiken voor dezelfde vergadering.
    fx.settings.autoRecordScope = 'all';
    fx.rooms = [activeRoom('t-cal-in-all')];
    fx.meetings = [{
        uid: 'uid-x', talkToken: 't-cal-in-all', organizer: { email: 'tom@x.nl' },
        attendees: [1, 2, 3, 4, 5].map(n => ({ email: `p${n}@x.nl` })),
    }];
    // Geen live deelnemers beschikbaar → onbekend → geen opname, ondanks zes
    // genodigden op de uitnodiging.
    await scanAndRecord();
    assert.deepEqual(fx.started, []);
    assert.equal(fx.talkCalls.some(c => c.name === 'nextcloud_talk_list_participants'), true,
        'de engine vraagt het na in plaats van de agenda te gebruiken');
});
