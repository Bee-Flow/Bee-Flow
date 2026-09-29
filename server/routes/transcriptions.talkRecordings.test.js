/**
 * GET /api/transcriptions/nextcloud-talk-recordings — the Talk import panel's
 * source of truth.
 *
 * Two regressions are pinned here:
 *
 *  1. `Depth: infinity`. SabreDAV ships `enablePropfindDepthInfinity = false`
 *     and Nextcloud never enables it, so the "one recursive round-trip" was
 *     clamped to depth 1 and only ever saw the recordings folder's immediate
 *     children — all folders. The panel was permanently empty ("No Talk
 *     recordings found"). The walk is now two explicit depth-1 levels.
 *
 *  2. The room token. Talk writes to `<attachmentFolder>/Recording/<token>/`,
 *     so parsing against `/Talk` yielded the literal token "Recording".
 *
 * Drives the REAL Express router with a fake WebDAV server; same require-cache
 * stub harness as transcriptions.gmeet.test.js.
 *
 * Run: cd server && node --test routes/transcriptions.talkRecordings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Mutable fixtures ─────────────────────────────────────────────────────────
const fx = {
    tree: {},              // folder path → [{ name, isDir, size, lastModified }]
    propfinds: [],         // { path, depth }
    settingsFolder: '/Talk/Recording',
    capability: { recordingEnabled: true, recordingFolder: '/Talk/Recording' },
    talkRooms: [],
    talkCalls: [],
    authThrows: null,
};

function resetFx() {
    fx.tree = {};
    fx.propfinds.length = 0;
    fx.settingsFolder = '/Talk/Recording';
    fx.capability = { recordingEnabled: true, recordingFolder: '/Talk/Recording' };
    fx.talkRooms = [];
    fx.talkCalls.length = 0;
    fx.authThrows = null;
}
resetFx();

// ── Require-cache stubs (before the router loads) ────────────────────────────
function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const UID = 'alice';
const BASE = 'https://cloud.example.test';
const FILES_ROOT = `/remote.php/dav/files/${UID}/`;

function xmlResponse(entries) {
    const body = entries.map(e => `
  <d:response>
    <d:href>${FILES_ROOT}${e.href.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${e.isDir ? '/' : ''}</d:href>
    <d:propstat><d:prop>
      <d:resourcetype>${e.isDir ? '<d:collection/>' : ''}</d:resourcetype>
      ${e.isDir ? '' : `<d:getcontentlength>${e.size ?? 0}</d:getcontentlength>`}
      <d:getlastmodified>${e.lastModified || 'Wed, 12 Aug 2026 09:00:00 GMT'}</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`).join('');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
}

/** Fake Nextcloud WebDAV: serves `fx.tree` for depth-1 PROPFIND, 404 otherwise. */
async function fakeFetch(url, opts = {}) {
    const u = new URL(url);
    const rel = decodeURIComponent(u.pathname.slice(FILES_ROOT.length - 1));
    const folder = '/' + rel.split('/').filter(Boolean).join('/');
    fx.propfinds.push({ path: folder, depth: opts.headers?.Depth });

    const children = fx.tree[folder];
    if (!children) return { ok: false, status: 404, text: async () => '' };

    // Depth 1 → the folder itself plus its direct children. Anything deeper is
    // NOT served: that is exactly what Nextcloud does to `Depth: infinity`.
    const entries = [{ href: folder, isDir: true }].concat(
        children.map(c => ({ ...c, href: `${folder === '/' ? '' : folder}/${c.name}` })),
    );
    return { ok: true, status: 207, text: async () => xmlResponse(entries) };
}

stub('../stores/transcriptionStore', { getTranscription: async () => null });
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
stub('../integrations/nextcloudClient', {
    resolveAuth: async () => {
        if (fx.authThrows) throw new Error(fx.authThrows);
        return { baseUrl: BASE, uid: UID, fetch: fakeFetch, authError: 'nc auth failed' };
    },
    webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`,
});
stub('../integrations/nextcloudTalkTools', {
    getTalkRecordingCapability: async () => ({ ...fx.capability }),
    executeNextcloudTalkTool: async (name, args) => {
        fx.talkCalls.push({ name, args });
        if (name === 'nextcloud_talk_list_rooms') return { count: fx.talkRooms.length, rooms: fx.talkRooms };
        return { error: 'unexpected tool' };
    },
});
stub('../core/meetingNotes/talkNotesSettings', {
    resolveTalkNotesSettings: async () => ({ recordingFolder: fx.settingsFolder, postSummaryBack: false }),
});

const router = require('./transcriptions');

// ── Dispatch harness ─────────────────────────────────────────────────────────
function dispatch({ method = 'GET', url, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query,
            headers: {},
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

const LIST = { url: '/nextcloud-talk-recordings' };

/** The layout a real Talk instance produces. */
function seedRealLayout() {
    fx.tree = {
        '/Talk': [
            { name: 'Recording', isDir: true },
            { name: 'Standup-a1b2c3d4', isDir: true },       // attachments folder
        ],
        '/Talk/Recording': [
            { name: 'a1b2c3d4', isDir: true },
            { name: 'zz88xx99', isDir: true },
        ],
        '/Talk/Recording/a1b2c3d4': [
            { name: 'recording-20260812.ogg', isDir: false, size: 1024, lastModified: 'Wed, 12 Aug 2026 09:00:00 GMT' },
            { name: 'recording-20260813.mp4', isDir: false, size: 4096, lastModified: 'Thu, 13 Aug 2026 09:00:00 GMT' },
        ],
        '/Talk/Recording/zz88xx99': [
            { name: 'call.ogg', isDir: false, size: 512, lastModified: 'Tue, 11 Aug 2026 09:00:00 GMT' },
        ],
        '/Talk/Standup-a1b2c3d4': [
            { name: 'voice-message.ogg', isDir: false, size: 64 },
        ],
    };
}

test('finds the recordings Talk actually wrote, grouped by real room token', async () => {
    resetFx();
    seedRealLayout();
    const res = await dispatch(LIST);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 3);
    assert.deepStrictEqual(res.body.rooms.map(r => r.token).sort(), ['a1b2c3d4', 'zz88xx99']);
    // The bug: /Talk + `rest[0]` made every recording belong to a room called
    // "Recording".
    assert.ok(!res.body.rooms.some(r => r.token === 'Recording'));

    const room = res.body.rooms.find(r => r.token === 'a1b2c3d4');
    assert.deepStrictEqual(
        room.recordings.map(r => r.name),
        ['recording-20260813.mp4', 'recording-20260812.ogg'],
        'newest first',
    );
    assert.strictEqual(room.recordings[0].kind, 'video');
    assert.strictEqual(room.recordings[1].kind, 'audio');
    assert.strictEqual(room.recordings[0].path, '/Talk/Recording/a1b2c3d4/recording-20260813.mp4');
});

test('never asks for Depth: infinity', async () => {
    resetFx();
    seedRealLayout();
    await dispatch(LIST);
    assert.ok(fx.propfinds.length > 0, 'it did PROPFIND something');
    for (const p of fx.propfinds) {
        assert.strictEqual(p.depth, '1', `PROPFIND ${p.path} used Depth: ${p.depth}`);
    }
});

test('a stored setting of /Talk still finds recordings one level down', async () => {
    resetFx();
    fx.settingsFolder = '/Talk';
    // Talk did not answer, so the configured value is all we have.
    fx.capability = { recordingEnabled: true, recordingFolder: null };
    seedRealLayout();
    const res = await dispatch(LIST);
    assert.deepStrictEqual(res.body.rooms.map(r => r.token).sort(), ['a1b2c3d4', 'zz88xx99']);
    // The conversation ATTACHMENT folder is not a room folder — its hyphenated
    // name fails the token shape, so its voice message is not offered as a
    // call recording.
    assert.ok(!res.body.rooms.some(r => r.recordings.some(x => x.name === 'voice-message.ogg')));
});

test('the recordings folder is taken from Talk capabilities when it answers', async () => {
    resetFx();
    fx.settingsFolder = '/Talk';                 // stale Bee Flow setting
    fx.capability = { recordingEnabled: true, recordingFolder: '/Meetings/Recording' };
    fx.tree = {
        '/Meetings/Recording': [{ name: 'qq11ww22', isDir: true }],
        '/Meetings/Recording/qq11ww22': [{ name: 'call.ogg', isDir: false, size: 1 }],
    };
    const res = await dispatch(LIST);
    assert.strictEqual(res.body.folder, '/Meetings/Recording');
    assert.deepStrictEqual(res.body.rooms.map(r => r.token), ['qq11ww22']);
});

test('an explicit ?folder= overrides both the setting and capabilities', async () => {
    resetFx();
    fx.capability = { recordingEnabled: true, recordingFolder: '/Talk/Recording' };
    fx.tree = {
        '/Custom': [{ name: 'kk55', isDir: true }],
        '/Custom/kk55': [{ name: 'a.ogg', isDir: false, size: 1 }],
    };
    const res = await dispatch({ ...LIST, query: { folder: '/Custom' } });
    assert.strictEqual(res.body.folder, '/Custom');
    assert.deepStrictEqual(res.body.rooms.map(r => r.token), ['kk55']);
});

test('conversation names are attached when Talk knows them', async () => {
    resetFx();
    seedRealLayout();
    fx.talkRooms = [{ token: 'a1b2c3d4', name: 'Daily standup' }];
    const res = await dispatch(LIST);
    assert.strictEqual(res.body.rooms.find(r => r.token === 'a1b2c3d4').name, 'Daily standup');
    // A room the user has left keeps its token and simply has no name.
    assert.strictEqual(res.body.rooms.find(r => r.token === 'zz88xx99').name, undefined);
});

test('an empty or missing recordings folder is a clean empty list', async () => {
    resetFx();
    fx.tree = {};                                 // nothing exists yet
    const res = await dispatch(LIST);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.rooms, []);
    assert.strictEqual(res.body.count, 0);
});

test('a disconnected Nextcloud is a 400, not a 500', async () => {
    resetFx();
    fx.authThrows = 'NOT_CONNECTED';
    const res = await dispatch(LIST);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /not connected/i);
});
