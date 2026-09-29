/**
 * Nothing may write a transcription's content columns without sealing them.
 *
 * transcriptionStore.js seals on its own write paths, but the store is not the
 * only writer: routes/transcriptions/reprocess.js goes round it deliberately,
 * because its UPDATE carries a claim predicate (`AND status = 'processing'`)
 * that the store's generic update cannot express. That is a legitimate reason
 * to write raw SQL and an easy way to write PLAINTEXT straight over an
 * encrypted note — silently, and only for the orgs that asked for encryption.
 *
 * So this sweeps the source for any statement touching those columns and
 * requires the file to be sealing. It is a text sweep rather than a runtime
 * check on purpose: the failure it guards against is a NEW writer added later,
 * which no runtime test would ever reach.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');
const { ALL_COLUMNS } = require('./transcriptCrypto');

/** Files allowed to write these columns, and what makes each one safe. */
const SEALERS = new Map([
    ['stores/transcriptionStore.js', 'transcriptCrypto.encryptRow'],
    ['routes/transcriptions/reprocess.js', 'transcriptCrypto.encryptRow'],
]);

function sourceFiles() {
    const out = execFileSync('git', ['ls-files', '*.js'], { cwd: SERVER, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).filter(f => !f.includes('.test.'))
        // `git ls-files` reads the INDEX, which lags the working tree: a file
        // renamed or deleted but not yet committed is still listed and is no
        // longer on disk. Reading it blindly turned an unrelated uncommitted
        // rename into a failure of this guard. A file that is gone writes
        // nothing, so skipping it cannot hide an offender.
        .filter(f => fs.existsSync(path.join(SERVER, f)));
}

test('every writer of a transcription content column seals it first', () => {
    // A statement that names the table and assigns one of the columns.
    const assigns = ALL_COLUMNS.map(c => new RegExp(`\\b${c}\\s*=\\s*\\$`));
    const offenders = [];

    for (const rel of sourceFiles()) {
        const src = fs.readFileSync(path.join(SERVER, rel), 'utf8');
        if (!/\b(UPDATE|INSERT INTO)\s+transcriptions\b/.test(src)) continue;
        const writesContent = assigns.some(re => re.test(src))
            || /INSERT INTO transcriptions\s*\([^)]*\bfull_text\b/.test(src);
        if (!writesContent) continue;
        const needle = SEALERS.get(rel);
        if (!needle) {
            offenders.push(`${rel} — writes transcription content and is not a known sealer`);
        } else if (!src.includes(needle)) {
            offenders.push(`${rel} — is listed as a sealer but does not call ${needle}`);
        }
    }

    assert.deepStrictEqual(offenders, [],
        'these files write a transcription content column without sealing it. Either route the write '
        + 'through stores/transcriptionStore.js, or seal it with transcriptCrypto.encryptRow and add the '
        + 'file to SEALERS in this test:\n' + offenders.join('\n'));
});

test('the sealer list has no stale entries', () => {
    // Genuinely textual, per the file header: this whole file is a text sweep
    // on purpose, guarding against a writer added LATER that no runtime input
    // could reach today. A file that stopped writing content should leave the
    // list, or the list stops meaning anything.
    for (const rel of SEALERS.keys()) {
        const full = path.join(SERVER, rel);
        assert.ok(fs.existsSync(full), `${rel} is listed as a sealer but does not exist`);
        const src = fs.readFileSync(full, 'utf8');
        assert.match(src, /\b(UPDATE|INSERT INTO)\s+transcriptions\b/,
            `${rel} no longer writes transcriptions — remove it from SEALERS`);
    }
});

test('the derived previews are written wherever their source column is', () => {
    // full_text_snippet_enc and summary_snippet_enc are derived from full_text
    // and summary. A writer that updates the source and forgets the preview
    // leaves the list showing the PREVIOUS meeting's opening lines, forever.
    for (const [rel] of SEALERS) {
        const src = fs.readFileSync(path.join(SERVER, rel), 'utf8');
        if (/\bfull_text\s*=\s*\$/.test(src) || /INSERT INTO transcriptions\s*\([^)]*\bfull_text\b/.test(src)) {
            assert.match(src, /full_text_snippet_enc/,
                `${rel} writes full_text but never full_text_snippet_enc`);
        }
        if (/\bsummary\s*=\s*\$/.test(src) || /INSERT INTO transcriptions\s*\([^)]*[\s,]summary[\s,]/.test(src)) {
            assert.match(src, /summary_snippet_enc/,
                `${rel} writes summary but never summary_snippet_enc`);
        }
    }
});
