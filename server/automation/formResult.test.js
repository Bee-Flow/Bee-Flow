'use strict';

/**
 * What a form journey's closing page can be turned into (BFSF-419). The
 * routes that use these are pinned in routes/automation/formPublic.test.js.
 *
 * Run: node --test automation/formResult.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { endingFrom, resultOf, markdownToSafeHtml, webpageSlots, aiStepsOf, resultFilename } = require('./formResult');

test('the LAST ending step is the closing page', () => {
    const steps = [
        { output: { mode: 'ending', form: { title: 'First' } } },
        { output: { mode: 'page', form: { title: 'A page' } } },
        { output: { mode: 'ending', form: { title: 'Last' } } },
        { output: null },
    ];
    assert.strictEqual(endingFrom(steps).title, 'Last');
    assert.strictEqual(endingFrom([]), null);
    assert.strictEqual(endingFrom(undefined), null);
});

test('a closing page without text has no result to keep', () => {
    assert.strictEqual(resultOf(null), null);
    assert.strictEqual(resultOf({ title: 'Thanks' }), null);
    assert.strictEqual(resultOf({ title: 'Thanks', description: '   ' }), null);
    assert.deepStrictEqual(resultOf({ title: ' Blog ', description: '## Kop\n\nTekst.\n' }), { title: 'Blog', markdown: '## Kop\n\nTekst.' });
});

test('markdown keeps its structure: headings, emphasis and tables', () => {
    const html = markdownToSafeHtml('## Toleranties\n\nIets **vet**.\n\n| Klasse | Tolerantie |\n|---|---|\n| Fijn | ±0,15 mm |');
    assert.match(html, /<h2>Toleranties<\/h2>/);
    assert.match(html, /<strong>vet<\/strong>/);
    assert.match(html, /<table>[\s\S]*<th>Klasse<\/th>[\s\S]*<td>±0,15 mm<\/td>/);
});

test('raw HTML in the markdown is shown as text, not carried along as markup', () => {
    // The form page renders this text without raw HTML too; model output is not
    // markup we want in a notebook or on a page.
    const html = markdownToSafeHtml('Hallo <script>alert(1)</script> en <img src=x onerror=alert(1)>\n\n<div onclick="x()">blok</div>');
    assert.ok(!/<script|<img|<div/i.test(html), html);
    assert.match(html, /&lt;script&gt;/);
});

test('an active link scheme does not survive', () => {
    const html = markdownToSafeHtml('[klik](javascript:alert(1))');
    assert.ok(!/javascript:/i.test(html), html);
});

test('the webpage is a complete document that links its stylesheet', () => {
    const { html, css } = webpageSlots({ title: 'CNC <draaiwerk>', markdown: 'Een alinea.' });
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<link rel="stylesheet" href="style.css">/);
    assert.match(html, /<title>CNC &lt;draaiwerk&gt;<\/title>/);
    assert.match(html, /<h1>CNC &lt;draaiwerk&gt;<\/h1>\n<p>Een alinea.<\/p>/);
    assert.match(css, /max-width/);
});

test('a text that opens with its own h1 does not get a second one', () => {
    const { html } = webpageSlots({ title: 'Blog', markdown: '# Eigen titel\n\nTekst.' });
    assert.strictEqual((html.match(/<h1>/g) || []).length, 1);
    assert.match(html, /<h1>Eigen titel<\/h1>/);
});

test('an automation with an AI step asks for marking; one without does not', () => {
    assert.strictEqual(aiStepsOf({ steps: [{ id: 's1', type: 'set' }] }), null);
    assert.strictEqual(aiStepsOf(null), null);
    const ai = aiStepsOf({ steps: [{ id: 's1', type: 'set' }, { id: 'ai1', type: 'ai_step', model: 'anthropic/claude-x' }] });
    assert.deepStrictEqual(ai, { aiStepIds: ['ai1'], provider: 'anthropic' });
});

test('download names are safe and never empty', () => {
    assert.strictEqual(resultFilename('CNC Draaiwerk: Toleranties & Kosten', 'docx'), 'cnc-draaiwerk-toleranties-kosten.docx');
    assert.strictEqual(resultFilename('', 'pdf'), 'result.pdf');
    assert.strictEqual(resultFilename('***', 'pdf'), 'result.pdf');
});
