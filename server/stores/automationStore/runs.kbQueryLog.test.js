'use strict';
/**
 * A kb_query_log step's output holds decrypted KB log text. The stored copy (automation_run_steps.output_json,
 * which outlives the log's retention and erasure) must not.
 *
 * Run: cd server && node --test stores/automationStore/runs.kbQueryLog.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordRunStepWith } = require('./runs');

const OUTPUT = {
    rows: [{ id: 'e1', query: 'Where is the vault key?', answer: 'In the safe.', chunks: [{ text: 'passage text' }], citations: [], reviewNote: 'private note', chunkCount: 1, outcome: 'answered' }],
    total: 1, count: 1,
};

async function stored(stepType) {
    let outputJson = null;
    await recordRunStepWith(async (_sql, params) => { outputJson = params[9]; }, {
        runId: 'r1', stepId: 's1', stepType, status: 'success', output: OUTPUT,
    });
    return outputJson;
}

test('a full-detail kb_query_log output leaves no question, answer, passage or note in the stored step', async () => {
    const json = await stored('kb_query_log');
    assert.doesNotMatch(json, /vault key|In the safe|passage text|private note/);
    assert.match(json, /"outcome":"answered"/);
});

test('other step types are stored as they are', async () => {
    assert.match(await stored('set'), /vault key/);
});
