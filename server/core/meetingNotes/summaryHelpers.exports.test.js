/**
 * Export contract for the meeting-notes helper modules.
 *
 * WHY THIS EXISTS
 * `summaryHelpers` re-exports the pure helpers from `transcriptArtifacts`, and
 * every consumer destructures from it. Every unit test of those consumers
 * require-cache-STUBS `summaryHelpers` — so when a helper was added to the
 * stub but not to the real module's `module.exports`, all of those tests went
 * green and the transcription pipeline died in production with
 * "tagSpeakerProvenance is not a function".
 *
 * A stubbed collaborator can never tell you whether the real collaborator has
 * the function. This test reads what consumers actually destructure and checks
 * it against the REAL modules, so the whole class of bug fails here instead of
 * on a user's meeting.
 *
 * Run: cd server && node --test core/meetingNotes/summaryHelpers.exports.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
// Keep the require cheap and DB/LLM-free — we only care about the export shape.
stub('../llm/llmClient', { chat: async () => ({ content: '{}' }) });
stub('../llm/modelResolver', {
    getEUAwareTiers: async () => ({}),
    resolveModelForTierName: async () => 'model',
});
stub('../privacy/piiDetection', { detectPii: async () => null });

const SERVER_ROOT = path.resolve(__dirname, '../..');
const SEARCH_DIRS = ['routes', 'core', 'integrations'].map(d => path.join(SERVER_ROOT, d));

/** Every .js file under the searched dirs, excluding tests. */
function sourceFiles(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) sourceFiles(full, out);
        else if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(full);
    }
    return out;
}

/**
 * Names destructured from `require(...<module>)` across the source tree.
 * @returns {Map<string, string[]>} name → files that want it
 */
function destructuredFrom(moduleBasename) {
    const wanted = new Map();
    // const { a, b } = require('…/<module>')  — multi-line, which is the
    // style every consumer here uses.
    const rx = new RegExp(`\\{([^}]*)\\}\\s*=\\s*require\\(['"][^'"]*${moduleBasename}['"]\\)`, 'gs');
    for (const dir of SEARCH_DIRS) {
        for (const file of sourceFiles(dir)) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(rx)) {
                for (const raw of m[1].split(',')) {
                    // Handles `name`, `name: alias` and trailing comments.
                    const name = raw.split(':')[0].replace(/\/\/.*$/gm, '').trim();
                    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
                    if (!wanted.has(name)) wanted.set(name, []);
                    wanted.get(name).push(path.relative(SERVER_ROOT, file));
                }
            }
        }
    }
    return wanted;
}

function assertExports(moduleBasename, mod) {
    const wanted = destructuredFrom(moduleBasename);
    assert.ok(wanted.size > 0, `found no consumers of ${moduleBasename} — the scan is broken, not the module`);

    const missing = [...wanted.entries()]
        .filter(([name]) => mod[name] === undefined)
        .map(([name, files]) => `  ${name}  ← wanted by ${[...new Set(files)].join(', ')}`);

    assert.deepStrictEqual(missing, [],
        `these names are destructured from ${moduleBasename} but not exported by it:\n${missing.join('\n')}`);
}

test('summaryHelpers exports everything its consumers destructure', () => {
    assertExports('summaryHelpers', require('./summaryHelpers'));
});

test('transcriptArtifacts exports everything its consumers destructure', () => {
    assertExports('transcriptArtifacts', require('./transcriptArtifacts'));
});

test('the pure helpers re-exported through summaryHelpers are the SAME functions', () => {
    // A re-export that silently drifts (a local redefinition shadowing the
    // import) would pass the checks above while behaving differently.
    const helpers = require('./summaryHelpers');
    const pure = require('./transcriptArtifacts');
    for (const name of [
        'buildTranscriptArtifacts', 'applySpeakerNames', 'applySpeakerSummaries',
        'tagSpeakerProvenance', 'fillGenericSpeakerLabels', 'buildPipelineNotices',
        'toContextBias', 'formatTime',
    ]) {
        assert.strictEqual(typeof pure[name], 'function', `transcriptArtifacts.${name} must exist`);
        assert.strictEqual(helpers[name], pure[name], `summaryHelpers.${name} must be the transcriptArtifacts one`);
    }
});
