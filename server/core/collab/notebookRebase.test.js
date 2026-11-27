// @typecheck strict
/**
 * Carrying a writer's change onto a co-edited notebook (core/collab/notebookRebase.js),
 * with the real editor serialization (core/markdown).
 *
 * Run: cd server && node --test core/collab/notebookRebase.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { rebaseEdit } = require('./notebookRebase');
const { markdownToHtml, htmlToMarkdown } = require('../markdown');

const BASE = '<h2>Plan</h2><p>Intro old.</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>Para five by team.</p>';

// The writer's changes made by the notebook chat's replace tool (integrations/notebookDocTools, the
// notebooks module's) are carried over in notebookRebase.notebooks.test.js.

const mdOf = (/** @type {{ html: string }} */ r) => htmlToMarkdown(r.html).trim();

test('a Markdown base (the workspace tools read Markdown) lines up with the live HTML', () => {
    const baseMd = htmlToMarkdown(BASE);
    const r = rebaseEdit({ markdown: baseMd }, { html: markdownToHtml(`${baseMd}\n\nAdded.`) }, BASE.replace('two', 'two!'));
    assert.strictEqual(r.conflict, false);
    assert.match(mdOf(/** @type {any} */ (r)), /- two!\n\nPara five by team\.\n\nAdded\.$/);
});
