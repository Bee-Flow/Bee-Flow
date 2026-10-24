/**
 * GET/PATCH /api/transcriptions/talk-meetings — the Scheduled list for Talk.
 *
 * Since M5 the per-meeting recording choice comes from `stores/meetingPrefsStore`
 * (table meeting_prefs) and no longer from the exclusion lists in the settings.
 * What is pinned here:
 *   - the route reads the preferences with the scope of THE CALLER (his userId
 *     plus his org), never with that of somebody else;
 *   - an exclusion makes `excluded: true` and therefore NO `will_record`;
 *   - the 1-on-1 default: an appointment with at most two participants is off by default, and an explicit choice wins over that;
 *   - the PATCH writes the caller's preference on both the space and the occurrence — the same scope that the old exclusion lists had.
 *
 * Drives the REAL Express router with require-cache stubs (same harness as
 * transcriptions.talkRecordings.test.js).
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions.talkMeetings.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    settings: {},
    capability: { recordingEnabled: true },
    rooms: [],
    meetings: [],
    prefs: {},          // 'kind:id' → true | false
    orgPrefs: {},       // ORG-brede rijen: alleen zichtbaar mét orgId
    tags: {},           // 'kind:id' → string[]  (meeting_prefs.tags)
    prefLoads: [],
    prefWrites: [],
    noteByToken: {},
};

function resetFx() {
    fx.settings = { autoRecord: true, autoRecordScope: 'calendar', recordingMode: 'audio', recordingFolder: '/Talk/Recording' };
    fx.capability = { recordingEnabled: true };
    fx.rooms = [];
    fx.meetings = [];
    fx.prefs = {};
    fx.orgPrefs = {};
    fx.tags = {};
    fx.prefLoads.length = 0;
    fx.prefWrites.length = 0;
    fx.noteByToken = {};
}
resetFx();

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/transcriptionStore', {
    getTranscription: async () => null,
    getTranscriptionByTalkRoomToken: async (token) => fx.noteByToken[token] || null,
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/summaryHelpers', {
    resolveSmartModel: () => 'model',
    identifySpeakerNames: async () => null,
    generateMeetingSummary: async () => '',
    generateMeetingTitle: async () => '',
    extractMeetingArtifacts: async () => ({ actionItems: [], decisions: [], questions: [], tags: [] }),
    generateSpeakerSummaries: async () => ({}),
    applySpeakerSummaries: (s) => s,
    toContextBias: () => [],
    applySpeakerNames: (merged) => ({ merged, transcript: '', speakers: [] }),
    transcribeWithWhisperX: async () => ({ segments: [], text: '' }),
});
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['orgA']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../integrations/nextcloudClient', { resolveAuth: async () => { throw new Error('NOT_CONNECTED'); }, webdavRoot: () => '' });
stub('../integrations/nextcloudTalkTools', {
    getTalkRecordingCapability: async () => ({ ...fx.capability }),
    executeNextcloudTalkTool: async (name) => (name === 'nextcloud_talk_list_rooms'
        ? { count: fx.rooms.length, rooms: fx.rooms }
        : { error: 'unexpected tool' }),
});
stub('../core/meetingNotes/talkNotesSettings', {
    resolveTalkNotesSettings: async () => ({ ...fx.settings }),
});
stub('../core/meetingNotes/talkCalendar', {
    listUpcomingTalkMeetings: async () => fx.meetings,
});
stub('../core/integrations/ncScopeGuard', {
    guardedNcCall: async (_tool, _args, _ctx, call) => call(),
});
// meeting_prefs (M5). The decision logic itself is fixed in
// stores/meetingPrefsStore.test.js; here it counts whether the route consults it with its own
// scope and translates its answer into `excluded` + the status chip.
stub('../stores/meetingPrefsStore', {
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
    setRecord: async (args) => {
        fx.prefWrites.push(args);
        // The write updates the fixture, so that the route can READ IT BACK.
        // If it did not, the answer of the PATCH could be no more than an echo of the request — and that is exactly where the fault lay.
        for (const { kind, id } of args.ids) fx.prefs[`${kind}:${id}`] = args.record;
        return 1;
    },
    loadMeetingPrefs: async ({ provider, userId, orgId }) => {
        fx.prefLoads.push({ provider, userId, orgId });
        // An ORG-wide row writes the real store as `user_id = ''` and reads it only via the org branch of
        // listPrefs; without orgId it is therefore invisible here. That is how leaving out the org scope turns red.
        // A FALSE WINS, from whichever row it comes — the user row does not overwrite the org row, as `resolvePrefs` does not either.
        const scopes = orgId ? [fx.orgPrefs, fx.prefs] : [fx.prefs];
        const opinionFor = (ids) => {
            const seen = ids.flatMap(({ kind, id }) => scopes.map(m => m[`${kind}:${id}`]));
            if (seen.includes(false)) return false;
            if (seen.includes(true)) return true;
            return null;
        };
        return {
            opinionFor,
            tagsFor: (ids) => {
                const out = [];
                for (const { kind, id } of ids) for (const tag of (fx.tags[`${kind}:${id}`] || [])) if (!out.includes(tag)) out.push(tag);
                return out;
            },
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
});

const router = require('./transcriptions');

function dispatch({ method = 'GET', url, body = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, body, query, headers: {},
            session: { user: { id: 'u1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

/** Een echte vergadering: organisator + twee genodigden. */
function meeting(overrides = {}) {
    return {
        uid: 'uid1', title: 'Weekly sync',
        start: '2026-09-10T10:00:00Z', end: '2026-09-10T11:00:00Z',
        organizer: { cn: 'Tom', email: 'tom@example.com' },
        attendees: [{ email: 'sanne@example.com' }, { email: 'ines@example.com' }],
        talkToken: 'tok1', calendar: 'personal',
        ...overrides,
    };
}

const moderatorRoom = (token = 'tok1') => ({ token, participantType: 2, hasCall: false, callRecording: 0, type: 2 });

test('de voorkeuren worden met de scope van de aanroeper geladen', async () => {
    resetFx();
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    await dispatch({ url: '/talk-meetings' });
    assert.deepEqual(fx.prefLoads, [{ provider: 'talk', userId: 'u1', orgId: 'orgA' }]);
});

test('een uitsluiting maakt excluded=true en dus geen will_record', async () => {
    resetFx();
    fx.meetings = [meeting(), meeting({ uid: 'uid2', talkToken: 'tok2' })];
    fx.rooms = [moderatorRoom('tok1'), moderatorRoom('tok2')];
    fx.prefs['room:tok2'] = false;

    const res = await dispatch({ url: '/talk-meetings' });
    const by = Object.fromEntries(res.body.meetings.map(m => [m.talkToken, m]));
    assert.equal(by.tok1.excluded, false);
    assert.equal(by.tok1.status, 'will_record');
    assert.equal(by.tok2.excluded, true, 'wie opnemen uitzette moet uit blijven');
    assert.equal(by.tok2.status, 'upcoming');
    assert.equal(by.tok2.recordReason, 'opted_out');
});

test('een uitsluiting op de OCCURRENCE telt ook als de ruimte vrij is', async () => {
    resetFx();
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    fx.prefs['event:uid1'] = false;
    const res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].excluded, true);
});

test('1-op-1-standaard: ten hoogste twee deelnemers staat standaard uit', async () => {
    resetFx();
    fx.meetings = [meeting({ attendees: [{ email: 'sanne@example.com' }] })]; // + organisator = 2
    fx.rooms = [moderatorRoom()];
    let res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].excluded, true);
    assert.equal(res.body.meetings[0].recordReason, 'small_meeting');
    assert.equal(res.body.meetings[0].status, 'upcoming');

    // ... but an explicit choice wins over that.
    fx.prefs['event:uid1'] = true;
    res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].excluded, false);
    assert.equal(res.body.meetings[0].status, 'will_record');
});

test('een agenda-afspraak zonder deelnemerslijst is ONBEKEND en versmalt', async () => {
    resetFx();
    fx.meetings = [meeting({ attendees: undefined })];
    fx.rooms = [moderatorRoom()];
    const res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].recordReason, 'unknown_size');
    assert.equal(res.body.meetings[0].excluded, true, 'onbekend telt niet als "meer dan twee"');
});

test('PATCH schrijft de voorkeur van de aanroeper op ruimte én occurrence', async () => {
    resetFx();
    const res = await dispatch({ method: 'PATCH', url: '/talk-meetings/tok1', body: { record: false, eventUid: 'uid1' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, token: 'tok1', record: false, effectiveRecord: false, overridden: false });
    assert.deepEqual(fx.prefWrites, [{
        provider: 'talk',
        ids: [{ kind: 'event', id: 'uid1' }, { kind: 'room', id: 'tok1' }],
        userId: 'u1',
        record: false,
    }], 'altijd de eigen rij — twee deelnemers aan dezelfde vergadering mogen verschillen');
});

test('PATCH meldt geen succes als een ORG-brede uitsluiting hem overruled', async () => {
    // One FALSE wins, also that of the org. The PATCH bounced the question back, the
    // row jumped to "Record", and at the next load it was on "Skip" again
    // without the screen having said anything about it. The reason that then comes back is
    // `opted_out` — precisely the reason that gets no explanation, because it counts as "your own choice". Here it was someone else's choice.
    resetFx();
    fx.orgPrefs['room:tok1'] = false;
    const res = await dispatch({ method: 'PATCH', url: '/talk-meetings/tok1', body: { record: true, eventUid: 'uid1' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.record, true, 'dit is wat er gevraagd werd');
    assert.equal(res.body.effectiveRecord, false, 'en dit is wat er geldt');
    assert.equal(res.body.overridden, true);
});

test('PATCH zonder eventUid raakt alleen de ruimte', async () => {
    resetFx();
    await dispatch({ method: 'PATCH', url: '/talk-meetings/tok1', body: { record: true } });
    assert.deepEqual(fx.prefWrites[0].ids, [{ kind: 'room', id: 'tok1' }]);
    assert.equal(fx.prefWrites[0].record, true);
});

// ── the list and the engine must not contradict each other ───────────────
//
// This was the HIGH finding: the route calculated with the agenda alone, the engine
// with the same agenda PLUS the conversation type PLUS a live count. For an agenda appointment without ATTENDEE lines the screen said "off" and the server recorded.
// Both sides now use `knownParticipantCount`; what only the engine can know travels to the screen as `recordDecided: false`.

test('een agenda-afspraak zonder deelnemerslijst is ONBESLIST, niet "uit"', async () => {
    resetFx();
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [moderatorRoom()];                 // type 2, groepsruimte
    const res = await dispatch({ url: '/talk-meetings' });
    const row = res.body.meetings[0];
    assert.equal(row.recordReason, 'unknown_size');
    assert.equal(row.recordDecided, false, 'de engine gaat bij de start nog tellen');
    assert.equal(row.status, 'decides_at_start', 'nooit een kale "Upcoming" over een gesprek dat wél opgenomen kan worden');
});

test('een 1-op-1-ruimte telt óók zonder agenda als twee — net als in de engine', async () => {
    resetFx();
    // A Talk conversation of type 1 is by definition a one-on-one. The engine
    // already knew that (room.type === 1 → 2); the route did not know it and said
    // "unknown", so the two gave a different explanation for the same row.
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [{ token: 'tok1', participantType: 2, hasCall: false, callRecording: 0, type: 1 }];
    const res = await dispatch({ url: '/talk-meetings' });
    const row = res.body.meetings[0];
    assert.equal(row.recordReason, 'small_meeting');
    assert.equal(row.recordDecided, true, 'hier valt niets meer te tellen');
    assert.equal(row.excluded, true);
});

test('in scope "all" telt de agenda niet mee — de engine kijkt er ook niet naar', async () => {
    resetFx();
    fx.settings.autoRecordScope = 'all';
    // Six invitees on the invitation. In scope 'all' talkAutoRecord does not
    // fill `calendarByToken`, so the engine decides on the LIVE count. The "Will record" chip
    // would here be a promise that the engine does not know.
    fx.meetings = [meeting({ attendees: [1, 2, 3, 4, 5].map(n => ({ email: `p${n}@example.com` })) })];
    fx.rooms = [moderatorRoom()];
    const res = await dispatch({ url: '/talk-meetings' });
    const row = res.body.meetings[0];
    assert.equal(row.recordReason, 'unknown_size');
    assert.equal(row.recordDecided, false);
    assert.notEqual(row.status, 'will_record');
});

test('onbeslist bestaat alleen zolang de engine echt gaat kijken', async () => {
    resetFx();
    fx.capability = { recordingEnabled: false };   // geen opnameback-end
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [moderatorRoom()];
    let res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].recordDecided, true, 'er gebeurt sowieso niets — "we kijken nog" zou de leugen zijn');
    assert.equal(res.body.meetings[0].status, 'upcoming');

    resetFx();
    fx.settings.autoRecord = false;                // globale schakelaar uit
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [moderatorRoom()];
    res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].recordDecided, true);

    resetFx();
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [{ token: 'tok1', participantType: 3, hasCall: false, callRecording: 0, type: 2 }];  // geen moderator
    res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.meetings[0].recordDecided, true);
});

test('een expliciete keuze wint van "onbeslist"', async () => {
    resetFx();
    fx.meetings = [meeting({ organizer: null, attendees: [] })];
    fx.rooms = [moderatorRoom()];
    fx.prefs['room:tok1'] = true;
    const res = await dispatch({ url: '/talk-meetings' });
    const row = res.body.meetings[0];
    assert.equal(row.recordReason, 'opted_in');
    assert.equal(row.recordDecided, true);
    assert.equal(row.excluded, false);
});

test('postSummaryBack reist mee, zodat de voetregel niet hoeft te zwijgen', async () => {
    resetFx();
    fx.settings.postSummaryBack = true;
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    const res = await dispatch({ url: '/talk-meetings' });
    assert.equal(res.body.postSummaryBack, true);

    resetFx();
    fx.settings.postSummaryBack = false;
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    const off = await dispatch({ url: '/talk-meetings' });
    assert.equal(off.body.postSummaryBack, false, 'false is een ontkenning, geen ontbrekend veld');
});

test('de tags van de AFSPRAAK reizen mee — anders had de rij een bron die er niet is', async () => {
    // The Scheduled row shows this read-only. Without `tagsFor` in the route, nothing
    // ever sent a `tags` field and that block could therefore never show anything.
    resetFx();
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    fx.tags['room:tok1'] = ['klant'];
    fx.tags['event:uid1'] = ['sales'];
    const res = await dispatch({ url: '/talk-meetings' });
    // Meest specifieke eerst: de occurrence vóór de ruimte.
    assert.deepEqual(res.body.meetings[0].tags, ['sales', 'klant']);
});
