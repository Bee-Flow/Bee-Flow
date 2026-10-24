/**
 * Talk auto-record × meeting_prefs (M5).
 *
 * This is the place where a recording actually STARTS. What goes wrong here is
 * not a wrong label in a list but a conversation that gets recorded while
 * someone had switched that off. Recorded here:
 *   - the preferences are loaded with the scope of THIS user;
 *   - an exclusion (room or occurrence) stops the recording;
 *   - the 1-on-1 default: a Talk conversation of type 1 is by definition
 *     two people and is not recorded automatically; an explicit choice wins;
 *   - a group room without a calendar appointment is not thrown away as "unknown"
 *     but ASKED at Talk — and if that fails, it stays unknown and so nothing is recorded.
 *
 * All dependencies are stubbed via the Module-resolve hook; no database,
 * no Nextcloud.
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

// Core reaches these clients through core/integrations/integrationClients.js
// (boot registers the real ones).
require('../integrations/integrationClients').registerIntegrationClients({
    nextcloudTalk: () => MOCKS['../../integrations/nextcloudTalkTools'],
});
// ...and the trigger bus through the triggerBus port of core/automationRunner/featurePorts.js.
require('../automationRunner/featurePorts').registerRunnerPorts({
    triggerBus: {
        loadSession: (...args) => MOCKS['../../automation/triggerBus'].loadSession(...args),
    },
});
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:talkautorecord:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
// The module under test consists of TWO files: talkAutoRecord.js and the
// shared participant counter talkParticipants.js. Both must go through the hook,
// and not only because the second has its own requires: they live in
// the SAME folder, and Node's `relativeResolveCache` is keyed on
// `${parent.path}\0${request}`. If only one of them is in the hook, the
// CHANCE order decides which of the two `../../stores/meetingPrefsStore` resolves
// first — and the answer of that one then also ends up in the other, mock or real.
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

/** An active call that this user moderates and does not yet answer. */
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
    // A group conversation with five MEMBERS of whom nobody carries the inCall bit.
    // The old fallback then read `res.count` — `participants.length` from the tool, i.e.
    // everyone who was ever added to the conversation — and started recording. That really
    // happens in production: the room list is fetched once at the top of the scan, and a
    // conversation that ended in the meantime yields inCall 0 everywhere.
    fx.rooms = [activeRoom('t-nul')];
    fx.participants['t-nul'] = { participants: [{ inCall: 0 }, { inCall: 0 }, { inCall: 0 }, { inCall: 0 }, { inCall: 0 }] };
    await scanAndRecord();
    assert.deepEqual(fx.started, [], 'onbekend versmalt — vijf leden zijn geen vijf deelnemers');
});

test('een deelnemersvorm zonder inCall-veld telt ook als onbekend', async () => {
    resetFx();
    // `Number(undefined) || 0` does the same as an explicit zero; an older
    // or deviating Talk version may not start a recording on the basis of nothing.
    fx.rooms = [activeRoom('t-geen-veld')];
    fx.participants['t-geen-veld'] = { participants: [{}, {}, {}, {}] };
    await scanAndRecord();
    assert.deepEqual(fx.started, []);
});

test('scope "all": de agenda telt niet mee, ook niet als hij er is', async () => {
    resetFx();
    // The engine fills `calendarByToken` only in calendar scope. The Scheduled
    // list therefore uses the same rule (knownParticipantCount), so that
    // the two do not each use a different number for the same meeting.
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
