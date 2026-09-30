/**
 * Carrying a writer's change onto a co-edited notebook (agents/notebooks/notebookRebase.js),
 * with the real editor serialization (core/markdown).
 *
 * Run: cd server && node --test agents/notebooks/notebookRebase.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { rebaseEdit } = require('./notebookRebase');
const { executeNotebookDocTool } = require('../../integrations/notebookDocTools');
const { markdownToHtml, htmlToMarkdown } = require('../../core/markdown');

const BASE = '<h2>Plan</h2><p>Intro old.</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>Para five by team.</p>';

/** What the notebook chat's replace tool makes of BASE. */
const aiReplace = (find, replace) => executeNotebookDocTool('notebook_doc_replace', { find_text: find, replace_text: replace }, BASE).content;
const mdOf = (r) => htmlToMarkdown(r.html).trim();

test('the writer\'s change lands next to a colleague\'s edits elsewhere, including the neighbouring block', () => {
    const current = '<h2>Plan</h2><p>Intro old.</p><ul><li><p>one</p></li><li><p>two, and three</p></li></ul><p>Para five by team, EDITED.</p><p>Closing by B.</p>';
    const r = rebaseEdit({ html: BASE }, { html: aiReplace('Intro old.', 'Intro rewritten by AI.') }, current);
    assert.strictEqual(r.conflict, false);
    assert.strictEqual(mdOf(r), '## Plan\n\nIntro rewritten by AI.\n\n- one\n- two, and three\n\nPara five by team, EDITED.\n\nClosing by B.');
});

test('two different changes to the same block are a conflict; the same change twice is made once', () => {
    const next = aiReplace('Intro old.', 'Intro by AI.');
    assert.deepStrictEqual(rebaseEdit({ html: BASE }, { html: next }, BASE.replace('Intro old.', 'Intro by Bob.')), { conflict: true, changed: false, html: null });
    const both = rebaseEdit({ html: BASE }, { html: next }, BASE.replace('Intro old.', 'Intro by AI.'));
    assert.strictEqual(both.conflict, false);
    assert.strictEqual(both.changed, false, 'already there: nothing to write');
});

test('removing a block a colleague changed is a conflict; adding at the end after their addition keeps both', () => {
    const current = BASE.replace('Para five by team.', 'Para five, reworded.');
    assert.strictEqual(rebaseEdit({ html: BASE }, { html: aiReplace('Para five by team.', '') }, current).conflict, true);
    const appended = rebaseEdit({ html: BASE }, { markdown: `${htmlToMarkdown(BASE)}\n\nSummary by AI.` }, `${BASE}<p>Closing by B.</p>`);
    assert.strictEqual(appended.conflict, false);
    assert.match(mdOf(appended), /Closing by B\.\n\nSummary by AI\.$/, 'the colleague\'s paragraph first, the AI\'s after it');
});

test('blocks the writer left alone stay the live nodes, with what Markdown does not carry', () => {
    const current = BASE.replace('<p>Para five by team.</p>', '<p style="text-align: center">Para five by team.</p>');
    const r = rebaseEdit({ html: BASE }, { html: aiReplace('Intro old.', 'Intro new.') }, current);
    assert.strictEqual(r.conflict, false);
    assert.match(r.html, /<p[^>]*text-align: ?center[^>]*>Para five by team\.<\/p>/, 'the centred paragraph is still centred');
    assert.match(r.html, /Intro new\./);
});

test('a Markdown base (the workspace tools read Markdown) lines up with the live HTML', () => {
    const baseMd = htmlToMarkdown(BASE);
    const r = rebaseEdit({ markdown: baseMd }, { html: markdownToHtml(`${baseMd}\n\nAdded.`) }, BASE.replace('two', 'two!'));
    assert.strictEqual(r.conflict, false);
    assert.match(mdOf(r), /- two!\n\nPara five by team\.\n\nAdded\.$/);
});
