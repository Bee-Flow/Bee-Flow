/**
 * sites.mjs is THE table of where each step type keeps its values. The test
 * that keeps it honest reads the runner: every interpolateTemplate call in
 * server/core/automationRunner renders a field this table lists (a text
 * site, or a binding site resolved through it). A new call, or a call that
 * moved to another field, fails here until the table says so; a field whose
 * executor checks `typeof === 'string'` first must be `compose: false`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEP_SITES, COMMON_SITES, stepBindingSites, textSitesOf, fieldValue } from './sites.mjs';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/automationRunner');

/** The first argument of every `interpolateTemplate(` call in a source text. */
function callArgs(src) {
    const out = [];
    const re = /interpolateTemplate\(/g;
    let m;
    while ((m = re.exec(src))) {
        let i = m.index + m[0].length;
        const start = i;
        let depth = 0;
        let quote = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; } else if (c === ',' && depth === 0) break;
        }
        out.push(src.slice(start, i).trim());
    }
    return out;
}

/**
 * Every call, in file order: its first argument, and the site(s) it renders
 * (`type.field`; several when one helper serves several fields).
 */
const CALL_SITES = {
    'execAi.js': [["step.prompt || ''", ['ai_step.prompt']]],
    'execApproval.js': [
        ['step.prompt', ['approval.prompt']],
        ['s', ['approval.approval.details']],
        ['s', ['form_page.form']],
    ],
    'execControl.js': [
        ["step.message || 'Stopped by stop_error step'", ['stop_error.message']],
        ['nav.recordRef', ['return_to_app.navigateTo.recordRef']],
        ['raw', ['return_to_app.toast.message']],
    ],
    'execDataExtraction.js': [['source', ['data_extraction.source']]],
    'execDocument.js': [
        ["step.content || ''", ['generate_document.content']],
        ["step.title || ''", ['generate_document.title']],
        ["step.fileName || ''", ['generate_document.fileName']],
    ],
    'execFillDocument.js': [
        ['raw', ['fill_document.values']],
        ["step.fileName || ''", ['fill_document.fileName']],
        ["step.copyName || ''", ['fill_document.copyName']],
    ],
    'execKnowledgeWrite.js': [['v', ['knowledge_write.content', 'knowledge_write.title', 'knowledge_write.sourceUri']]],
    'execOutbound.js': [
        ['step.title', ['notification.title']],
        ['step.body', ['notification.body']],
        ["step.url || ''", ['http_request.url']],
        ["typeof v === 'string' ? v : ''", ['http_request.headers']],
        ['step.body', ['http_request.body']],
    ],
    'execPresentation.js': [
        ['raw', ['presentation.slides', 'slide.stats', 'slide.chart.data']],
        ["step.title || ''", ['slide.title']],
        ["step.content || ''", ['slide.content']],
        ["step.notes || ''", ['slide.notes']],
        ["step.image || ''", ['slide.image']],
        ['c[k]', ['slide.chart.labels', 'slide.chart.values', 'slide.chart.unit']],
        ["step.title || ''", ['presentation.title']],
        ["step.subtitle || ''", ['presentation.subtitle']],
        ["step.fileName || ''", ['presentation.fileName']],
        ["step.copyName || ''", ['presentation.copyName']],
    ],
};

function siteListed(key) {
    const [type, ...rest] = key.split('.');
    const field = rest.join('.');
    const entry = STEP_SITES[type];
    if (!entry) return false;
    return (entry.text || []).some(t => t.field === field) || (entry.bindings || []).includes(field);
}

test('every interpolateTemplate call in the runner renders a field sites.mjs lists', () => {
    const files = fs.readdirSync(RUNNER).filter(f => f.endsWith('.js') && !/\.test\.js$/.test(f)).sort();
    const found = {};
    for (const f of files) {
        const args = callArgs(fs.readFileSync(path.join(RUNNER, f), 'utf8'));
        if (args.length) found[f] = args;
    }
    assert.deepStrictEqual(Object.keys(found).sort(), Object.keys(CALL_SITES).sort(), 'a runner file started or stopped rendering texts');
    for (const [file, calls] of Object.entries(CALL_SITES)) {
        assert.deepStrictEqual(found[file], calls.map(([arg]) => arg), `${file}: its interpolateTemplate calls changed; update CALL_SITES and sites.mjs`);
        for (const [, sites] of calls) for (const site of sites) assert.ok(siteListed(site), `${file}: ${site} is not in sites.mjs`);
    }
});

test('a text whose executor reads only a string is marked compose: false', () => {
    const plainOnly = ['approval.approval.details', 'form_page.form', 'return_to_app.toast.message', 'return_to_app.navigateTo.recordRef', 'http_request.headers', 'slide.chart.labels', 'slide.chart.values', 'slide.chart.unit'];
    for (const key of plainOnly) {
        const [type, ...rest] = key.split('.');
        const site = textSitesOf(type).find(t => t.field === rest.join('.'));
        assert.ok(site, key);
        assert.equal(site.compose, false, key);
    }
    assert.equal(textSitesOf('notification').every(t => t.compose), true, 'a notification renders a compose title and body');
    assert.deepStrictEqual(textSitesOf('nope'), []);
});

test('lift: a template is turned into a compose only where the text takes one and lift is not off', () => {
    const site = (type, field) => textSitesOf(type).find(t => t.field === field);
    // An ai_step's prompt reads its own inputs by name; a slide's content
    // renders a list as a markdown block. Both render a stored compose.
    for (const [type, field] of [['ai_step', 'prompt'], ['slide', 'content']]) {
        assert.equal(site(type, field).compose, true, `${type}.${field} renders a compose`);
        assert.equal(site(type, field).lift, false, `${type}.${field} keeps its template`);
    }
    assert.equal(site('notification', 'body').lift, true);
    // A text that takes no compose never lifts to one.
    for (const [type, entry] of Object.entries(STEP_SITES)) {
        for (const t of entry.text || []) if (!t.compose) assert.equal(t.lift, false, `${type}.${t.field}`);
    }
});

test('stepBindingSites: every place this step keeps a value, in table order', () => {
    const step = {
        id: 'n1', type: 'notification', title: 'Hi', body: { kind: 'compose', v: 1, parts: ['x'] },
        inputs: { a: { kind: 'ref', path: 'steps.s.output.a' } }, repeat: { over: { root: 'steps', id: 's', path: ['rows'] } },
    };
    assert.deepStrictEqual(stepBindingSites(step).map(s => [s.kind, s.field, s.compose]), [
        ['binding', 'inputs', undefined],
        ['list', 'repeat.over', undefined],
        ['text', 'title', true],
        ['text', 'body', true],
    ]);
    const http = { type: 'http_request', url: 'u', headers: { A: '{{x}}', B: 'y' } };
    assert.deepStrictEqual(stepBindingSites(http).map(s => s.field), ['url', 'headers.A', 'headers.B']);
    const sw = { type: 'switch', expr: 'a', cases: [{ expr: 'b' }, {}, { expr: 'c' }] };
    assert.deepStrictEqual(stepBindingSites(sw).map(s => s.field), ['expr', 'cases.0.expr', 'cases.2.expr']);
    assert.deepStrictEqual(stepBindingSites({ type: 'unknown', inputs: {} }).map(s => s.field), ['inputs']);
    assert.deepStrictEqual(stepBindingSites(null), []);
    assert.deepStrictEqual(COMMON_SITES.lists, ['forEach.overRef', 'repeat.over']);
    assert.equal(fieldValue({ a: Object.create({ b: 1 }) }, 'a.b'), undefined, 'own properties only');
});
