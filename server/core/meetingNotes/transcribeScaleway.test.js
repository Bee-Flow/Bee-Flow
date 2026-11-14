/**
 * transcribeWithScaleway, chunked path: a chunk that fails stays a GAP (not
 * speech) all the way out, and it ends where the audio ends.
 *
 * ffmpeg and the config store are stand-ins, Scaleway is a local HTTP server
 * and the diarizer a scripted fetch; the overlap speaker assignment and the
 * transcript artifacts are the real ones.
 *
 * Run: cd server && node --test core/meetingNotes/transcribeScaleway.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('node:http');
const os = require('os');
const path = require('path');

const { makeSwaps } = require('../../testUtils/swaps');

// The real modules, their functions swapped before the module under test
// reads them (transcribeScaleway takes ffmpeg's two functions at load).
const swaps = makeSwaps();
/** What the store answers for scaleway_url; null leaves the default host. */
let scalewayUrl = null;
function stub(request, fns) {
    const mod = require(request);
    for (const [name, fn] of Object.entries(fns)) swaps.swap(mod, name, fn);
}
test.after(() => swaps.restore());

stub('../../stores/configStore', {
    getSecret: async (k) => (k === 'scaleway_api_key' ? 'key' : null),
    getConfig: async (k) => (k === 'scaleway_url' ? scalewayUrl : null),
});
// The split writes a two-chunk segment list: 0-600 s and a SHORT last chunk 600-900 s.
stub('../media/ffmpeg', {
    buildAudioArgs: (opts) => opts,
    runFfmpeg: async (opts) => {
        const o = opts.outputOptions || [];
        const listPath = o[o.indexOf('-segment_list') + 1];
        const dir = path.dirname(listPath);
        fs.writeFileSync(path.join(dir, 'chunk_000.mp3'), 'a');
        fs.writeFileSync(path.join(dir, 'chunk_001.mp3'), 'b');
        fs.writeFileSync(listPath, 'chunk_000.mp3,0.000000,600.000000\nchunk_001.mp3,600.000000,900.000000\n');
    },
});

const { transcribeWithScaleway } = require('./transcribeScaleway');
const { buildTranscriptArtifacts } = require('./transcriptArtifacts');

test('a failed chunk stays a gap: no speaker gets its airtime and it ends at the real audio end', async (t) => {
    const env = { ...process.env };
    process.env.SCALEWAY_CHUNK_THRESHOLD_BYTES = '1';
    process.env.WHISPERX_URL = 'http://diarizer.test';
    // Scaleway: the first chunk transcribes, the second is refused.
    const scaleway = http.createServer((req, res) => {
        const parts = [];
        req.on('data', (c) => parts.push(c));
        req.on('end', () => {
            const body = Buffer.concat(parts).toString('latin1');
            if (req.url === '/v1/audio/transcriptions' && body.includes('filename="chunk_000.mp3"')) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ segments: [{ text: 'hello', start: 0, end: 590 }] }));
                return;
            }
            res.statusCode = 400;
            res.end('bad chunk');
        });
    });
    await new Promise((r) => scaleway.listen(0, '127.0.0.1', r));
    scalewayUrl = `http://127.0.0.1:${scaleway.address().port}`;
    const realFetch = global.fetch;
    global.fetch = async (url) => {
        assert.ok(String(url).endsWith('/diarize'), `only the diarizer goes through this fetch, got ${url}`);
        return new Response(JSON.stringify({ speakers: [
            { start: 0, end: 600, speaker: 'A' }, { start: 600, end: 900, speaker: 'B' },
        ] }), { status: 200 });
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw-test-'));
    t.after(() => {
        global.fetch = realFetch;
        scaleway.close();
        scalewayUrl = null;
        process.env = env;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'meeting.mp3');
    fs.writeFileSync(file, 'xxxxxxxx');

    const { segments } = await transcribeWithScaleway(file, 'meeting.mp3', 'en', '');
    const gap = segments.find((s) => /could not be transcribed/.test(s.text));
    assert.ok(gap, 'the failed chunk is in the transcript');
    assert.strictEqual(gap.gap, true, 'the gap flag survives the mapping');
    assert.strictEqual(gap.end, 900, 'the gap ends where the audio ends, not at start + CHUNK_SECONDS');

    const built = buildTranscriptArtifacts(segments);
    assert.deepStrictEqual(built.speakers.map((s) => s.id), ['A'], 'the hole is nobody\'s speaking time');
    assert.strictEqual(built.totalDuration, 900);
});

test('a Scaleway address on a link-local range is refused and no request goes out', async (t) => {
    const env = { ...process.env };
    delete process.env.SCALEWAY_CHUNK_THRESHOLD_BYTES;
    delete process.env.WHISPERX_URL;
    scalewayUrl = 'http://169.254.169.254';
    const realFetch = global.fetch;
    let fetched = 0;
    global.fetch = async () => { fetched += 1; return Response.json({ segments: [] }); };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw-test-'));
    t.after(() => {
        global.fetch = realFetch;
        process.env = env;
        scalewayUrl = null;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'meeting.mp3');
    fs.writeFileSync(file, 'xxxxxxxx');

    await assert.rejects(() => transcribeWithScaleway(file, 'meeting.mp3', 'en', ''), /metadata or link-local address/);
    assert.strictEqual(fetched, 0);
});
