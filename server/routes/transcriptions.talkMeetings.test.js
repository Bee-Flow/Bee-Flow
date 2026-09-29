/**
 * GET/PATCH /api/transcriptions/talk-meetings — de Gepland-lijst voor Talk.
 *
 * Sinds M5 komt de per-vergadering opnamekeuze uit `stores/meetingPrefsStore`
 * (tabel meeting_prefs) en niet meer uit de exclusielijsten in de instellingen.
 * Wat hier vastligt:
 *   - de route leest de voorkeuren met de scope van DE AANROEPER (zijn userId
 *     plus zijn org), nooit met die van iemand anders;
 *   - een uitsluiting maakt `excluded: true` en dus géén `will_record`;
 *   - de 1-op-1-standaard: een afspraak met ten hoogste twee deelnemers staat
 *     standaard uit, en een expliciete keuze wint daarvan;
 *   - de PATCH schrijft de voorkeur van de aanroeper op zowel de ruimte als de
 *     occurrence — hetzelfde bereik dat de oude exclusielijsten hadden.
 *
 * Drijft de ECHTE Express-router met require-cache-stubs (zelfde harnas als
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
// meeting_prefs (M5). De beslislogica zelf ligt vast in
// stores/meetingPrefsStore.test.js; hier telt of de route hem met de eigen
// scope raadpleegt en zijn antwoord in `excluded` + de statuschip vertaalt.
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
        // De schrijf werkt de fixture bij, zodat de route hem kan TERUGLEZEN.
        // Deed hij dat niet, dan kon het antwoord van de PATCH niet meer zijn
        // dan een echo van het verzoek — en juist daar zat de fout.
        for (const { kind, id } of args.ids) fx.prefs[`${kind}:${id}`] = args.record;
        return 1;
    },
    loadMeetingPrefs: async ({ provider, userId, orgId }) => {
        fx.prefLoads.push({ provider, userId, orgId });
        // Een ORG-brede rij schrijft de echte store als `user_id = ''` en leest
        // hij alleen via de org-tak van listPrefs; zonder orgId is hij hier dus
        // onzichtbaar. Zo wordt het weglaten van de org-scope wél rood.
        // EEN FALSE WINT, uit welke rij hij ook komt — de user-rij overschrijft
        // de org-rij niet, zoals `resolvePrefs` het ook niet doet.
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

    // ... maar een expliciete keuze wint daarvan.
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
    // Eén FALSE wint, ook die van de org. De PATCH kaatste de vraag terug, de
    // rij sprong op "Record", en bij de volgende load stond hij weer op "Skip"
    // zonder dat het scherm iets had gezegd. De reden die dán terugkomt is
    // `opted_out` — precies de reden die géén uitleg krijgt, want die geldt als
    // "je eigen keuze". Hier was het de keuze van iemand anders.
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

// ── de lijst en de engine mogen elkaar niet tegenspreken ─────────────
//
// Dit was de HOOG-bevinding: de route rekende met de agenda alléén, de engine
// met dezelfde agenda PLUS het conversatietype PLUS een live telling. Bij een
// agenda-afspraak zonder ATTENDEE-regels zei het scherm "uit" en nam de server
// op. Beide kanten gebruiken nu `knownParticipantCount`; wat alleen de engine
// kan weten reist als `recordDecided: false` naar het scherm.

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
    // Talk-conversatie van type 1 is per definitie een één-op-één. De engine
    // wist dat al (room.type === 1 → 2); de route wist het niet en zei
    // "onbekend", dus de twee gaven een verschillende verklaring voor dezelfde rij.
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
    // Zes genodigden op de uitnodiging. In scope 'all' vult talkAutoRecord
    // `calendarByToken` niet, dus de engine beslist op de LIVE telling. De chip
    // "Will record" zou hier een belofte zijn die de engine niet kent.
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
    // De Gepland-rij toont deze read-only. Zonder `tagsFor` in de route stuurde
    // niets ooit een `tags`-veld en kon dat blok dus nooit iets laten zien.
    resetFx();
    fx.meetings = [meeting()];
    fx.rooms = [moderatorRoom()];
    fx.tags['room:tok1'] = ['klant'];
    fx.tags['event:uid1'] = ['sales'];
    const res = await dispatch({ url: '/talk-meetings' });
    // Meest specifieke eerst: de occurrence vóór de ruimte.
    assert.deepEqual(res.body.meetings[0].tags, ['sales', 'klant']);
});
