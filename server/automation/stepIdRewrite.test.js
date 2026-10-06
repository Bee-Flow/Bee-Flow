'use strict';

/**
 * The step-id rewriters behind import, Blueprint install and upgrade: only the
 * step-id token changes, every other byte stays as the author wrote it, and a
 * step id that only appears as TEXT (a quoted literal, a key, a match value)
 * is not a step address.
 *
 * Run: node --test automation/stepIdRewrite.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { rewriteRefPath, rewriteTemplate, rewriteExpr, rewriteAnyString } = require('./stepIdRewrite');
const { parsePath, parseExpr } = require('./expr');

const MAP = { s1: 's1_new', graph: 'graph_ab12cd' };

test('a reference path: dotted, bracketed in either quote, with spacing kept', () => {
    assert.strictEqual(rewriteRefPath('steps.s1.output.items[0].name', MAP), 'steps.s1_new.output.items[0].name');
    assert.strictEqual(rewriteRefPath('steps["s1"].output.x', MAP), 'steps["s1_new"].output.x');
    assert.strictEqual(rewriteRefPath("steps[ 's1' ].output", MAP), "steps[ 's1_new' ].output");
    assert.strictEqual(rewriteRefPath('  steps.s1.output  ', MAP), '  steps.s1_new.output  ');
    // The tail is never re-spelled, even where a canonical spelling exists.
    assert.strictEqual(rewriteRefPath('steps.s1.output.items.0.first-name', MAP), 'steps.s1_new.output.items.0.first-name');
});

test('a path whose tail does not parse still gets its step renamed', () => {
    assert.strictEqual(rewriteRefPath('steps.s1.output.fields.Story Points', MAP), 'steps.s1_new.output.fields.Story Points');
});

test('only a whole step-id token is renamed', () => {
    assert.strictEqual(rewriteRefPath('steps.s10.output', MAP), 'steps.s10.output');
    assert.strictEqual(rewriteRefPath('trigger.output.steps.s1', MAP), 'trigger.output.steps.s1');
    assert.strictEqual(rewriteRefPath('steps[0].output', MAP), 'steps[0].output');
    // Own keys only: Object.prototype is not a rename map.
    assert.strictEqual(rewriteRefPath('steps.constructor.output', MAP), 'steps.constructor.output');
    assert.strictEqual(rewriteExpr('steps.toString.output', MAP), 'steps.toString.output');
});

// ── Match segments (`list[key="value"]`) ────────────────────────────────

test('a match segment is carried through byte for byte', () => {
    const path = 'steps.s1.output.payload.headers[name="Subject"].value';
    const out = rewriteRefPath(path, MAP);
    assert.strictEqual(out, 'steps.s1_new.output.payload.headers[name="Subject"].value');
    assert.ok(parsePath(out), 'still one path');
    assert.strictEqual(rewriteTemplate(`Re: {{ ${path} }}`, MAP), 'Re: {{ steps.s1_new.output.payload.headers[name="Subject"].value }}');
    assert.strictEqual(rewriteExpr(`${path} == "x"`, MAP), 'steps.s1_new.output.payload.headers[name="Subject"].value == "x"');
    for (const spelling of ["list[id='s1']", 'list[id=5]', 'list[ok=true]', 'list[v=null]', 'list["odd key"="s1"]']) {
        const p = `steps.graph.output.${spelling}.v`;
        assert.strictEqual(rewriteRefPath(p, MAP), `steps.graph_ab12cd.output.${spelling}.v`, spelling);
    }
});

test('a step id inside a match VALUE (or key) is a value, not a step address', () => {
    assert.strictEqual(rewriteRefPath('steps.other.output.list[id="s1"].v', MAP), 'steps.other.output.list[id="s1"].v');
    assert.strictEqual(rewriteRefPath('steps[id="s1"]', MAP), 'steps[id="s1"]');
    assert.strictEqual(rewriteRefPath('steps["s1"="x"]', MAP), 'steps["s1"="x"]');
    assert.strictEqual(rewriteTemplate('{{steps.other.output.list[step="graph"].v}}', MAP), '{{steps.other.output.list[step="graph"].v}}');
    assert.strictEqual(rewriteExpr('steps.other.output.list[id="s1"].v > 1', MAP), 'steps.other.output.list[id="s1"].v > 1');
    assert.strictEqual(rewriteExpr('list[steps="s1"]', MAP), 'list[steps="s1"]');
});

// ── Templates ───────────────────────────────────────────────────────────

test('templates: every placeholder, quote-aware, text and spacing untouched', () => {
    assert.strictEqual(
        rewriteTemplate('A {{steps.s1.output.a}} B {{ steps["graph"].output["a}}b"] }} C {{trigger.output.x}}', MAP),
        'A {{steps.s1_new.output.a}} B {{ steps["graph_ab12cd"].output["a}}b"] }} C {{trigger.output.x}}',
    );
    assert.strictEqual(rewriteTemplate('no placeholders: steps.s1.output', MAP), 'no placeholders: steps.s1.output');
    assert.strictEqual(rewriteTemplate('{{}} and {{ unclosed steps.s1', MAP), '{{}} and {{ unclosed steps.s1');
});

test('templates: the `{{{ … }}}` spelling the runner reads is renamed too, braces and spacing kept', () => {
    // The shared scanner reads `{{{ x }}}` as `{{ x }}`, so the runner
    // resolves it; a copy that kept the old id there would render a blank.
    assert.strictEqual(
        rewriteTemplate('{{steps.s1.output.a}}{{{ steps.s1.output.b }}}', MAP),
        '{{steps.s1_new.output.a}}{{{ steps.s1_new.output.b }}}',
    );
    assert.strictEqual(rewriteTemplate('Total: {{{steps.s1.output.total}}} EUR', MAP), 'Total: {{{steps.s1_new.output.total}}} EUR');
    assert.strictEqual(
        rewriteTemplate('{{{ steps["graph"].output["a}}}b"] }}}', MAP),
        '{{{ steps["graph_ab12cd"].output["a}}}b"] }}}',
    );
    // A new id that is not an identifier is bracketed inside the triple form as well.
    assert.strictEqual(rewriteTemplate('{{{ steps.s1.output.x }}}', { s1: 'my step' }), '{{{ steps["my step"].output.x }}}');
    // `$` in an id is literal text, not a replacement pattern.
    assert.strictEqual(rewriteTemplate('{{{ steps["s1"].output.x }}}', { s1: 'a$&b' }), '{{{ steps["a$&b"].output.x }}}');
    // `{{ x }}}` is a placeholder plus a stray `}`: the placeholder follows, the `}` stays.
    assert.strictEqual(rewriteTemplate('{{ steps.s1.output.x }}}', MAP), '{{ steps.s1_new.output.x }}}');
    // `{{{ x }}` is not a path the runner can read (its inside starts with `{`): left alone.
    assert.strictEqual(rewriteTemplate('{{{ steps.s1.output.x }}', MAP), '{{{ steps.s1.output.x }}');
});

// ── Expressions ─────────────────────────────────────────────────────────

test('expressions: references renamed, quoted text and members left alone', () => {
    assert.strictEqual(
        rewriteExpr('steps.s1.output.n > 0 && steps.s1.output.label != "steps.s1 failed"', MAP),
        'steps.s1_new.output.n > 0 && steps.s1_new.output.label != "steps.s1 failed"',
    );
    assert.strictEqual(rewriteExpr("vars.steps.s1 + steps [ 's1' ].x + steps.s1x", MAP), "vars.steps.s1 + steps [ 's1_new' ].x + steps.s1x");
    assert.strictEqual(rewriteExpr('len(steps.graph.output.items) > steps.s1.output.min', MAP), 'len(steps.graph_ab12cd.output.items) > steps.s1_new.output.min');
    // `{{ }}` in an expression is a mistake the validator names; the id still follows.
    assert.strictEqual(rewriteExpr('{{steps.s1.output.total}} > 5', MAP), '{{steps.s1_new.output.total}} > 5');
    const out = rewriteExpr('steps["s1"].output.items[steps.s1.output.i]', MAP);
    assert.strictEqual(out, 'steps["s1_new"].output.items[steps.s1_new.output.i]');
    assert.doesNotThrow(() => parseExpr(out));
});

test('a string of unknown role: template, whole path, expression — prose untouched', () => {
    assert.strictEqual(rewriteAnyString('steps.graph.output.body.value', MAP), 'steps.graph_ab12cd.output.body.value');
    assert.strictEqual(rewriteAnyString('Hi {{steps.s1.output.name}}', MAP), 'Hi {{steps.s1_new.output.name}}');
    assert.strictEqual(rewriteAnyString('steps.s1.output.total * 2', MAP), 'steps.s1_new.output.total * 2');
    assert.strictEqual(rewriteAnyString('see steps.s1 for context', MAP), 'see steps.s1 for context');
});

test('a string of unknown role that is a path with a broken tail still gets its step renamed', () => {
    // A loop's overRef or a datetime input with a sloppy tail: the run cannot
    // read it before or after a copy, but the copy must not ALSO name a step
    // that no longer exists (and the fix the validator suggests for the tail
    // must name the new id).
    for (const [before, after] of [
        ['steps.s1.output.fields.Story Points', 'steps.s1_new.output.fields.Story Points'],
        ['steps.s1.output.', 'steps.s1_new.output.'],
        ['steps.s1.output..x', 'steps.s1_new.output..x'],
        ['steps.s1.', 'steps.s1_new.'],
        ['steps.s1.output.items[0', 'steps.s1_new.output.items[0'],
        ['steps["s1"].output.a b', 'steps["s1_new"].output.a b'],
        ['  steps.s1.output.é x', '  steps.s1_new.output.é x'],
        ['steps.s1.output.x >', 'steps.s1_new.output.x >'],
    ]) {
        assert.strictEqual(rewriteAnyString(before, MAP), after, before);
    }
});

test('prose that merely starts with a step address is still left alone', () => {
    for (const prose of [
        'steps.s1 failed',
        'steps["s1"] failed again',
        'steps.s1, then steps.graph',
        'steps.s1.output.total\nis the number to watch',
        'steps.s10.output.a b',
        'note: steps.s1.output.Story Points',
    ]) {
        assert.strictEqual(rewriteAnyString(prose, MAP), prose, prose);
    }
});

test('a new id that is not an identifier is bracketed, so the text still reads', () => {
    const odd = { s1: 'my step' };
    assert.strictEqual(rewriteRefPath('steps.s1.output.x', odd), 'steps["my step"].output.x');
    assert.strictEqual(rewriteExpr('steps.s1.output.x > 1', odd), 'steps["my step"].output.x > 1');
    assert.strictEqual(rewriteRefPath("steps['s1'].output", { s1: "it's" }), "steps['it\\'s'].output");
});
