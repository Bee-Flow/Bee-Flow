/**
 * isAbout, the first host function: parse rules, evaluation from a score
 * table, and the helpers the runner's pre-pass and the builder preview share.
 * The client runs the same HOST_CASES in sharedExpr.parity.test.js.
 *
 * Run: node --test shared/expr/topics.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tryEvaluate, parseExpr, compile, collectHostCalls, EXPR_FUNCTION_NAMES } from './engine.mjs';
import { SCOPE, HOST_SCORES, HOST_CASES, HOST_REJECT } from './corpus.mjs';
import {
    TOPIC_HOST_SPEC, MAX_TOPIC_TEXT_CHARS, normalizeTopicText, topicCallsOf, makeTopicHost,
} from './topics.mjs';

const scored = () => makeTopicHost(new Map(Object.entries(HOST_SCORES)), { defaultThreshold: 0.5 });

test('host corpus evaluates as expected', () => {
    const host = scored();
    for (const { expr, expected } of HOST_CASES) {
        assert.deepEqual(evaluate(expr, SCOPE, { host }), expected, `expr: ${expr}`);
    }
});

test('host rejects throw at parse time even with the host', () => {
    for (const expr of HOST_REJECT) {
        assert.throws(() => parseExpr(expr, { host: TOPIC_HOST_SPEC }), `should reject: ${expr}`);
    }
});

test('without a host, isAbout is an unknown function, as before', () => {
    assert.throws(() => parseExpr('isAbout(item.body, "a complaint")'), /Unknown function: isAbout/);
    assert.ok(!EXPR_FUNCTION_NAMES.includes('isAbout'), 'isAbout must stay out of the pure whitelist');
});

test('a host cannot shadow a whitelisted function', () => {
    const host = { upper: { check: () => null, fn: () => 'HOSTED' } };
    assert.equal(evaluate('upper("a")', {}, { host }), 'A');
});

test('the parse error names the fix', () => {
    assert.throws(
        () => parseExpr('isAbout(item.body, item.topic)', { host: TOPIC_HOST_SPEC }),
        /topic in quotes, like isAbout\(item\.body, "a complaint"\)/,
    );
});

test('a parsed host call evaluated without scores says why instead of guessing', () => {
    const ast = parseExpr('isAbout(item.region, "a region")', { host: TOPIC_HOST_SPEC });
    assert.throws(() => evaluate(ast, SCOPE), /no answer here/);
    assert.throws(() => evaluate(ast, SCOPE, { host: TOPIC_HOST_SPEC }), /only answered while the step runs/);
    const { value, error } = tryEvaluate('isAbout(item.region, "a region")', SCOPE, { host: TOPIC_HOST_SPEC });
    assert.equal(value, undefined);
    assert.match(error, /only answered while the step runs/);
});

test('a text that should have a score and has none is fatal, not a silent false', () => {
    const host = makeTopicHost(new Map(), { defaultThreshold: 0.5 });
    assert.throws(() => evaluate('isAbout(item.region, "a region")', SCOPE, { host }), (e) => e.topicFatal === true);
});

test('an inherited property name is not a score', () => {
    const host = makeTopicHost(new Map([['EU', {}]]));
    assert.throws(() => evaluate('isAbout(item.region, "constructor")', SCOPE, { host }), (e) => e.topicFatal === true);
});

test('topicCallsOf collects every call across expressions, topics distinct and sorted', () => {
    const asts = [
        'isAbout(item.body, "b topic") || isAbout(item.subject, "a topic")',
        'isAbout(item.body, " b topic ") && item.total > 3',
        'item.total > 3',
        null,
    ].map((src) => (src ? parseExpr(src, { host: TOPIC_HOST_SPEC }) : null));
    const { labels, calls } = topicCallsOf(asts);
    assert.deepEqual(labels, ['a topic', 'b topic']);
    assert.equal(calls.length, 3);
});

test('collectHostCalls finds calls in branches, indexes and arguments', () => {
    const ast = parseExpr(
        'len(vars[isAbout(item.a, "x") ? "k" : "j"]) > 0 ? isAbout(item.b, "y") : !isAbout(item.c, "z")',
        { host: TOPIC_HOST_SPEC },
    );
    assert.deepEqual(collectHostCalls(ast).map((n) => n.args[1].v), ['x', 'y', 'z']);
});

test('compile still reports the roots a host call reads', () => {
    const { refs } = compile('isAbout(item.body, "a") && vars.on', { host: TOPIC_HOST_SPEC });
    assert.deepEqual([...refs].sort(), ['item', 'vars']);
});

test('normalizeTopicText: one stable key per value', () => {
    assert.equal(normalizeTopicText(null), '');
    assert.equal(normalizeTopicText(undefined), '');
    assert.equal(normalizeTopicText('  hello \n'), 'hello');
    assert.equal(normalizeTopicText(42), '42');
    assert.equal(normalizeTopicText(false), 'false');
    assert.equal(normalizeTopicText(['a', null, ' b ', '']), 'a\nb');
    assert.equal(normalizeTopicText({ a: 1 }), '{"a":1}');
    const long = normalizeTopicText(`${'a'.repeat(MAX_TOPIC_TEXT_CHARS)} closing line`);
    assert.equal(long.length, MAX_TOPIC_TEXT_CHARS);
    assert.ok(long.startsWith('aaa') && long.endsWith(' closing line'), 'a long text keeps its start and its end');
    assert.equal(normalizeTopicText(long), long, 'normalising twice changes nothing (the score key)');
});
