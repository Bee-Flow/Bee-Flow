/**
 * GET /api/transcriptions/nextcloud-audio-files against real WebDAV shapes.
 *
 * The listing decoded each href twice (once whole, once for the name), so one
 * audio file with a `%` in its name ("100% final.mp3") threw a URIError and
 * the whole folder answered 500; a name with a literal `%20` came back with a
 * space, a path that does not exist. It also read the XML with regexes on a
 * fixed `d:` prefix. Both listings now go through the shared WebDAV parser.
 *
 * Run: cd server && node --test routes/transcriptions.nextcloudAudioFiles.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const BASE = 'https://cloud.example.test';
const fx = { uid: 'alice', xml: '', requests: /** @type {string[]} */ ([]) };

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
    resolveAuth: async () => ({
        baseUrl: BASE,
        uid: fx.uid,
        authError: 'nc auth failed',
        fetch: async (url) => { fx.requests.push(String(url)); return { ok: true, status: 207, text: async () => fx.xml }; },
    }),
    webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`,
});
stub('../integrations/nextcloudTalkTools', {
    getTalkRecordingCapability: async () => ({ recordingEnabled: true, recordingFolder: '/Talk/Recording' }),
    executeNextcloudTalkTool: async () => ({ count: 0, rooms: [] }),
});
stub('../core/meetingNotes/talkNotesSettings', {
    resolveTalkNotesSettings: async () => ({ recordingFolder: '/Talk/Recording', postSummaryBack: false }),
});

const router = require('./transcriptions');

function dispatch(url, query = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, query, headers: {}, session: { user: { id: 'u1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

/** One multistatus entry; `prefix` is the DAV namespace prefix the server chose. */
function entry(href, { dir = false, size = 10, type = 'audio/mpeg', prefix = 'd' } = {}) {
    const p = prefix;
    return `<${p}:response><${p}:href>${href}</${p}:href><${p}:propstat><${p}:prop>
      <${p}:resourcetype>${dir ? `<${p}:collection/>` : ''}</${p}:resourcetype>
      ${dir ? '' : `<${p}:getcontentlength>${size}</${p}:getcontentlength><${p}:getcontenttype>${type}</${p}:getcontenttype>`}
      <${p}:getlastmodified>Wed, 12 Aug 2026 09:00:00 GMT</${p}:getlastmodified>
    </${p}:prop><${p}:status>HTTP/1.1 200 OK</${p}:status></${p}:propstat></${p}:response>`;
}
const multistatus = (entries, prefix = 'd') => `<?xml version="1.0"?><${prefix}:multistatus xmlns:${prefix}="DAV:">${entries.join('')}</${prefix}:multistatus>`;

test('a file with a percent sign in its name does not break the listing', async () => {
    fx.uid = 'alice';
    fx.xml = multistatus([
        entry('/remote.php/dav/files/alice/My%20Recordings/', { dir: true }),
        entry('/remote.php/dav/files/alice/My%20Recordings/100%25%20final.mp3'),
        entry('/remote.php/dav/files/alice/My%20Recordings/a%2520b.wav', { type: 'audio/wav' }),
        entry('/remote.php/dav/files/alice/My%20Recordings/notes.txt', { type: 'text/plain' }),
        entry('/remote.php/dav/files/alice/My%20Recordings/Archive/', { dir: true }),
    ]);
    const res = await dispatch('/nextcloud-audio-files', { folder: '/My Recordings' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items.map((i) => [i.name, i.path]).sort(), [
        ['100% final.mp3', '/My Recordings/100% final.mp3'],
        ['a%20b.wav', '/My Recordings/a%20b.wav'],
    ]);
    assert.strictEqual(res.body.items.find((i) => i.name === '100% final.mp3').size, 10);
    assert.strictEqual(res.body.items.find((i) => i.name === '100% final.mp3').contentType, 'audio/mpeg');
});

test('the listing does not depend on the namespace prefix or on an unencoded uid', async () => {
    // An e-mail style uid arrives percent-encoded in the href; the DAV prefix is the server's choice.
    fx.uid = 'jan@example.org';
    fx.xml = multistatus([
        entry('/remote.php/dav/files/jan%40example.org/Recordings/', { dir: true, prefix: 'x' }),
        entry('/remote.php/dav/files/jan%40example.org/Recordings/call.ogg', { type: 'audio/ogg', prefix: 'x' }),
    ], 'x');
    const res = await dispatch('/nextcloud-audio-files', {});
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items.map((i) => i.path), ['/Recordings/call.ogg']);
});
