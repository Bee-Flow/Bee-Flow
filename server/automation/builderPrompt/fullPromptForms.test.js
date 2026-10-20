'use strict';

/**
 * The "Form wizards" section of the full builder prompt: spliced into the full
 * prompt (and with it the MCP guide) and kept out of the lean one; it teaches
 * the new field types, the run-data attributes and the patterns built from
 * them. Neutral wording is enforced by the repo-level word check, not here.
 *
 * Run: cd server && node --test automation/builderPrompt/fullPromptForms.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FULL_PROMPT_FORMS } = require('./fullPromptForms');
const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('../builderPrompt');

const catalog = { apps: [] };
const full = buildFullSystemPrompt({ catalog, codeStepEnabled: true });

test('the full prompt carries the section, once, before the error-handling pitfalls', () => {
    assert.equal(full.split('## Form wizards').length, 2);
    assert.ok(full.indexOf('## Form wizards') > full.indexOf('## Hard rules'));
    assert.ok(full.indexOf('## Form wizards') < full.indexOf('## Error handling'));
    assert.ok(full.includes(FULL_PROMPT_FORMS));
});

test('it teaches the field types, the run-data attributes and the patterns', () => {
    for (const term of ['radio', 'multiselect', 'info', 'optionsFrom', 'fieldsFrom', 'showIf', 'minLength', 'pattern', 'patternMessage',
        'when', '_skipped', 'mode "ending"', 'coalesce', 'runPolicy', 'concurrency', 'parallel', 'VALUE', 'second form trigger']) {
        assert.ok(FULL_PROMPT_FORMS.includes(term), `the section names ${term}`);
    }
    assert.match(FULL_PROMPT_FORMS, /\{key, label, answer\}/);
    assert.match(FULL_PROMPT_FORMS, /never on label text/);
});

test('the section stays a concise guide section', () => {
    const lines = FULL_PROMPT_FORMS.split('\n').length;
    assert.ok(lines >= 50 && lines <= 100, `${lines} lines`);
});

test('the form_page menu entry points at it', () => {
    assert.match(full, /Optional `when` \(a condition expression\) skips the page/);
    assert.match(full, /"Form wizards" below/);
});

test('the lean prompt does not need it', () => {
    const lean = buildLeanSystemPrompt({ catalog, codeStepEnabled: true });
    assert.ok(!lean.includes('## Form wizards'));
});

test('the bounded retry guards the second call and joins before it coalesces', () => {
    const retry = FULL_PROMPT_FORMS.slice(FULL_PROMPT_FORMS.indexOf('**A bounded retry'), FULL_PROMPT_FORMS.indexOf('**Several people'));
    assert.match(retry, /condition on the first check's verdict/);
    assert.match(retry, /on\s+its failure branch only/);
    assert.match(retry, /never runs when\s+the first check passed/);
    assert.match(retry, /coalesce\(steps\.<second call>\.output\.verdict, steps\.<first call>\.output\.verdict\)/);
    assert.ok(!/second form_page whose `when`/.test(retry), 'no unguarded second call');
});

test('the concurrency hint uses the wording of the settings screen', () => {
    assert.match(FULL_PROMPT_FORMS, /"Run at the same time" set to "Allowed at the same time"/);
    assert.ok(!FULL_PROMPT_FORMS.includes('Run several at once'));
});
