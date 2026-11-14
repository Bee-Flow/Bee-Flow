/**
 * noteText.mts: the failure reason and the notice lines a pipeline writes
 * into a note's summary.
 *
 * Run: cd server && node --test usecases/transcriptions/noteText.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { failureReason, failureSummary, leadingNotices, withNotices, summaryFailedNotice } = require('./noteText.mts');

test('an upstream response body never reaches the note, the status does', () => {
    const body = 'Traceback (most recent call last):\n  File "/srv/whisperx/app/main.py", line 212\nConnectionError: could not reach gpu-node-07.internal.corp:5432 (postgres://whisper:pw@10.2.3.4/jobs)';
    const s = failureSummary(new Error(`WhisperX service error (500): ${body}`));
    assert.strictEqual(s, 'Transcription failed: WhisperX service error (500)');
});

test('a message meant for the user passes through', () => {
    assert.strictEqual(failureSummary(new Error('Mistral API key not configured. Go to Admin → AI Config → API Keys.')),
        'Transcription failed: Mistral API key not configured. Go to Admin → AI Config → API Keys.');
    assert.strictEqual(failureReason(new Error('Transcription returned no segments.')), 'Transcription returned no segments.');
});

test('addresses, internal hosts and key-like tokens are redacted, and the reason is cut', () => {
    const r = failureReason(new Error('connect ECONNREFUSED 10.0.0.12:9000 at http://whisperx.internal:9000/asr key tok_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'));
    assert.doesNotMatch(r, /10\.0\.0\.12|whisperx\.internal|a1b2c3d4/);
    assert.ok(failureReason(new Error('x'.repeat(20) + ' ' + 'y '.repeat(400))).length <= 300);
    assert.strictEqual(failureReason(null), 'unknown error');
});

test('leading notices split off the stored summary, and go back in front', () => {
    const stored = '⚠️ Transcription stopped early at 42:10 — the rest is missing.\nℹ️ Automatic voice recognition failed.\n\nOLD SUMMARY\n⚠️ not a notice: inside the body';
    const { notices, body } = leadingNotices(stored);
    assert.deepStrictEqual(notices, ['⚠️ Transcription stopped early at 42:10 — the rest is missing.', 'ℹ️ Automatic voice recognition failed.']);
    assert.strictEqual(body, 'OLD SUMMARY\n⚠️ not a notice: inside the body');
    assert.strictEqual(withNotices(notices, 'NEW'), `${notices.join('\n')}\n\nNEW`);
    assert.strictEqual(withNotices([], 'NEW'), 'NEW');
    assert.deepStrictEqual(leadingNotices(null), { notices: [], body: '' });
});

test('the summary-failed notice follows the language and says whether a summary was kept', () => {
    assert.match(summaryFailedNotice('nl', true), /^⚠️ .*vorige samenvatting is bewaard/);
    assert.match(summaryFailedNotice('en', false), /^⚠️ Writing the summary failed/);
});
