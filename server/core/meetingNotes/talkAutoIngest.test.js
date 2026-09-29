/**
 * Talk recording auto-ingest — the `file.new` side-effect tap.
 *
 * Two things are pinned here.
 *
 * Attribution. Talk's recording backend uploads through
 * `/recording/{token}/store`, authenticated by the recording secret rather than
 * a user session — so `webhook_listeners` serializes the delivery with
 * `user: null` and the connector forwards no `ncUid`. Keying the note owner off
 * that absent actor meant every auto-recorded call fell through to the org's
 * `defaultOwnerUserId`, which is unset on most tenants: the recording was
 * dropped with "no mappable owner". The owning uid is in the node path all
 * along (`/<uid>/files/…` → `payload.owner`).
 *
 * The room token. Recordings live at `<attachmentFolder>/Recording/<token>/…`,
 * so the token handed downstream must be the real room token — the armed-token
 * check, the participant roster and the Talk write-back all key off it.
 *
 * Run: cd server && node --test core/meetingNotes/talkAutoIngest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fx = {
    orgSettings: {},
    userSettings: {},
    settingsCalls: [],
    usersByNcUid: {},
    users: {},
    ingests: [],
    armed: new Set(),
    disarmed: [],
    session: { pseudo: true },
    existingBySourceUri: {},
};

function resetFx() {
    fx.orgSettings = { autoTranscribe: false, recordingFolder: '/Talk/Recording', defaultOwnerUserId: null, language: 'nl', postSummaryBack: false };
    fx.userSettings = {};
    fx.settingsCalls.length = 0;
    fx.usersByNcUid = { orgA: { alice: { id: 'u-alice' }, bob: { id: 'u-bob' } } };
    fx.users = { 'u-alice': { organizationId: 'orgA' }, 'u-bob': { organizationId: 'orgA' } };
    fx.ingests.length = 0;
    fx.armed = new Set();
    fx.disarmed.length = 0;
    fx.session = { pseudo: true };
    fx.existingBySourceUri = {};
}
resetFx();

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Real path parsing (that is half of what is under test), stubbed ingest.
const realPaths = require('./talkRecordingPaths');
stub('./ingestNextcloudRecording', {
    parseTalkRoomToken: realPaths.parseTalkRoomToken,
    ACCEPTED_RECORDING_EXTS: ['.ogg', '.mp4', '.webm', '.ogv', '.mkv', '.mp3', '.wav'],
    ingestNextcloudRecording: async (args) => { fx.ingests.push(args); return { id: 'note-1' }; },
});
stub('./talkNotesSettings', {
    resolveTalkNotesSettings: async ({ orgId = null, userId = null } = {}) => {
        fx.settingsCalls.push({ orgId, userId });
        return { ...fx.orgSettings, ...(userId ? (fx.userSettings[userId] || {}) : {}) };
    },
});
stub('../../stores/transcriptionStore', {
    getTranscriptionBySourceUri: async (uri) => fx.existingBySourceUri[uri] || null,
});
stub('../../stores/userStore', {
    getUser: async (id) => fx.users[id] || null,
    getUserByNcUid: async (orgId, ncUid) => (fx.usersByNcUid[orgId] || {})[ncUid] || null,
});
stub('../../automation/triggerBus', { loadSession: async () => fx.session });
stub('./talkAutoRecord', {
    isArmed: async (userId, token) => fx.armed.has(`${userId}:${token}`),
    disarmToken: async (userId, token) => { fx.disarmed.push(`${userId}:${token}`); },
});

const { maybeIngest } = require('./talkAutoIngest');

const REC_PATH = '/Talk/Recording/a1b2c3d4/recording-20260813-140000.ogg';

/** A file.new payload exactly as the connector normalises it. */
function payload({ path = REC_PATH, owner = 'alice', actor = null } = {}) {
    return { path, name: path.split('/').pop(), owner, actor, actorName: null };
}

test('the recording is attributed to the uid whose Files root it landed in', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    // The delivery carries no actor — the recording backend has no user session.
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests.length, 1, 'it ingested');
    assert.strictEqual(fx.ingests[0].userId, 'u-alice');
    assert.strictEqual(fx.ingests[0].orgId, 'orgA');
});

test('the room token is the conversation token, not the folder name', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests[0].talkRoomToken, 'a1b2c3d4');
    assert.strictEqual(fx.ingests[0].sourceUri, 'talk://orgA/a1b2c3d4/recording-20260813-140000.ogg');
});

test('a tenant still configured with /Talk resolves the same token', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    fx.orgSettings.recordingFolder = '/Talk';
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests.length, 1);
    assert.strictEqual(fx.ingests[0].talkRoomToken, 'a1b2c3d4');
});

test('a mapped event actor still wins over the file owner', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    await maybeIngest({ payload: payload({ owner: 'alice' }), userId: 'u-bob', orgId: 'orgA' });

    assert.strictEqual(fx.ingests[0].userId, 'u-bob');
});

test('an unmappable owner falls back to the org default owner', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    fx.orgSettings.defaultOwnerUserId = 'u-bob';
    await maybeIngest({ payload: payload({ owner: 'someone-federated' }), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests[0].userId, 'u-bob');
});

test('no owner and no org default → skipped, not ingested to nobody', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    await maybeIngest({ payload: payload({ owner: null }), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests.length, 0);
});

test('settings are resolved for the OWNER, so a personal opt-in is honoured', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = false;          // org has no opinion
    fx.userSettings['u-alice'] = { autoTranscribe: true };
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests.length, 1, 'alice opted in herself');
    assert.ok(
        fx.settingsCalls.some(c => c.userId === 'u-alice'),
        'the settings lookup was scoped to the owner',
    );
});

test('autoTranscribe off and not auto-recorded → nothing happens', async () => {
    resetFx();
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });
    assert.strictEqual(fx.ingests.length, 0);
});

test('a room armed by auto-record transcribes even with autoTranscribe off', async () => {
    resetFx();
    fx.armed.add('u-alice:a1b2c3d4');               // armed against the REAL token
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });

    assert.strictEqual(fx.ingests.length, 1);
    assert.deepStrictEqual(fx.disarmed, ['u-alice:a1b2c3d4'], 'and disarmed afterwards');
});

test('files outside the recordings folder are ignored', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    await maybeIngest({ payload: payload({ path: '/Documents/interview.ogg' }), userId: null, orgId: 'orgA' });
    await maybeIngest({ payload: payload({ path: '/Talk/Recording/a1b2c3d4/notes.txt' }), userId: null, orgId: 'orgA' });
    assert.strictEqual(fx.ingests.length, 0);
});

test('an already-ingested recording is not ingested twice', async () => {
    resetFx();
    fx.orgSettings.autoTranscribe = true;
    fx.existingBySourceUri['talk://orgA/a1b2c3d4/recording-20260813-140000.ogg'] = { id: 'note-old' };
    await maybeIngest({ payload: payload(), userId: null, orgId: 'orgA' });
    assert.strictEqual(fx.ingests.length, 0);
});
