'use strict';

/**
 * The "Reliable AI steps" section of the full builder prompt: spliced into the
 * full prompt (and with it the MCP guide) after the form wizards, kept out of
 * the lean one, and every JSON example in it is a shape the builder accepts.
 *
 * Run: cd server && node --test automation/builderPrompt/fullPromptAiChecks.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FULL_PROMPT_AI_CHECKS } = require('./fullPromptAiChecks');
const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('../builderPrompt');
const { sanitizeAiStepReliabilityArgs, CHECK_KINDS, SCRIPTS } = require('../../core/automationModel/aiStepReliability');

const catalog = { apps: [] };
const full = buildFullSystemPrompt({ catalog, codeStepEnabled: true });

/** The one-line JSON examples of the section: lines that start with a brace. */
const exampleLines = FULL_PROMPT_AI_CHECKS.split('\n').filter((l) => /^\s*\{"/.test(l));

test('the full prompt carries the section once, after the form wizards and before the pitfalls', () => {
    assert.equal(full.split('## Reliable AI steps').length, 2);
    assert.ok(full.includes(FULL_PROMPT_AI_CHECKS));
    assert.ok(full.indexOf('## Reliable AI steps') > full.indexOf('## Form wizards'));
    assert.ok(full.indexOf('## Reliable AI steps') < full.indexOf('## Error handling'));
});

test('the lean prompt does not carry it', () => {
    const lean = buildLeanSystemPrompt({ catalog, codeStepEnabled: true });
    assert.ok(!lean.includes('## Reliable AI steps'));
});

test('the section stays a concise guide section', () => {
    const lines = FULL_PROMPT_AI_CHECKS.split('\n').length;
    assert.ok(lines >= 60 && lines <= 90, `${lines} lines`);
});

test('it teaches every field, check kind and script of the spec', () => {
    for (const term of ['outputSchema', 'STRUCTURED', 'temperature', 'enumFrom', 'checks', 'fallback', 'askOnce', 'acrossRuns',
        'forEach', 'concurrency', 'batchSize', 'loop.<var>', 'sameCountAs', 'ai_check_failed', 'checkReport', 'repair round',
        'Answers from AI steps', 'results[*].output.results', ...CHECK_KINDS, ...SCRIPTS]) {
        assert.ok(FULL_PROMPT_AI_CHECKS.includes(term), `the section names ${term}`);
    }
});

test('every JSON example parses and is accepted by the builder', () => {
    assert.ok(exampleLines.length >= 7, `${exampleLines.length} examples`);
    for (const line of exampleLines) {
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(line.trim()); }, `parses: ${line.slice(0, 60)}`);
        const res = sanitizeAiStepReliabilityArgs(parsed);
        assert.ok(!('error' in res), `accepted: ${line.slice(0, 60)} -> ${res.error}`);
    }
});

test('the examples together use every check kind, a value fallback, askOnce and concurrency', () => {
    const all = exampleLines.map((l) => JSON.parse(l.trim()));
    const kinds = new Set(all.flatMap((a) => (a.checks || []).map((c) => c.kind)));
    for (const k of CHECK_KINDS) assert.ok(kinds.has(k), `an example uses ${k}`);
    assert.ok(all.some((a) => a.enumFrom && a.enumFrom.length));
    assert.ok(all.some((a) => a.fallback && a.fallback.kind === 'value'));
    assert.ok(all.some((a) => a.askOnce && a.askOnce.acrossRuns === true));
    assert.ok(all.some((a) => a.forEach && a.forEach.concurrency === 3));
});

test('the long-list example checks the whole batch', () => {
    const batch = exampleLines.map((l) => JSON.parse(l.trim())).find((a) => a.type === 'ai_step' && a.inputs);
    assert.ok(batch, 'a loop-body example exists');
    assert.equal(batch.inputs.batch.path, 'loop.batch');
    assert.deepEqual(batch.checks.find((c) => c.kind === 'items'), { kind: 'items', field: 'results', sameCountAs: 'loop.batch' });
    assert.deepEqual(batch.checks.find((c) => c.kind === 'allowedFrom'), { kind: 'allowedFrom', field: 'results[].id', ref: 'loop.batch', value: 'id' });
    assert.equal(batch.outputSchema.properties.results.type, 'array');
});

test('the text carries no prices and no placeholder tags', () => {
    const forbidden = /[€$£]\s?\d|\[(confirm|source|todo)\]/i;
    assert.doesNotMatch(FULL_PROMPT_AI_CHECKS, forbidden);
});
