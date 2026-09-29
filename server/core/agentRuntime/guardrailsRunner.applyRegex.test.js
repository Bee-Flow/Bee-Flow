/**
 * DB-free unit test for applyRegexGuardrails (M1 Step B).
 *
 * Stubs the DB-touching requires so guardrailsRunner loads without a DB, but
 * uses the REAL checkRegexPatterns so the scan + [REDACTED: name] loop is
 * exercised end-to-end. Asserts the pass/redact/block verdict, exact SSE event
 * shapes, redact-into-base behavior, and the audit-only-when-provided contract.
 *
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 core/agentRuntime/guardrailsRunner.applyRegex.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const logCalls = [];
const restore = installResolveStub({
    '../../stores/configStore': { getConfig: async () => null },
    '../privacy/piiDetection': { validateInputForPii: async () => null },
    '../privacy/orgShield': { resolveShieldFor: async () => null, mergeWithOrgShield: () => null },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { logCalls.push(row); } },
});

const { applyRegexGuardrails } = require('./guardrailsRunner');

const RULES = { enabled: true, scope: { userInput: true, agentOutput: true }, action: 'redact', rulesWithNames: [{ name: 'digits', pattern: '\\d{3}' }] };
function events() { const e = []; return { e, emit: (type, data) => e.push({ type, data }) }; }
function reset() { logCalls.length = 0; }

test('pass: disabled config → action pass, text unchanged, no events/log', () => {
    reset();
    const { e, emit } = events();
    const r = applyRegexGuardrails({ text: 'call 123', regexConfig: { enabled: false }, scope: 'userInput', emit, audit: {} });
    assert.deepEqual(r, { action: 'pass', processedText: 'call 123', ruleNames: null });
    assert.equal(e.length, 0);
    assert.equal(logCalls.length, 0);
});

test('pass: scope flag off → pass even when rules match', () => {
    reset();
    const { e, emit } = events();
    const cfg = { ...RULES, scope: { userInput: false } };
    const r = applyRegexGuardrails({ text: 'call 123', regexConfig: cfg, scope: 'userInput', emit, audit: {} });
    assert.equal(r.action, 'pass');
    assert.equal(e.length, 0);
});

test('pass: enabled but no match → pass', () => {
    reset();
    const { e, emit } = events();
    const r = applyRegexGuardrails({ text: 'no numbers here', regexConfig: RULES, scope: 'userInput', emit, audit: {} });
    assert.equal(r.action, 'pass');
    assert.equal(r.processedText, 'no numbers here');
    assert.equal(e.length, 0);
    assert.equal(logCalls.length, 0);
});

test('redact: replaces match, emits content_redact, logs redacted', () => {
    reset();
    const { e, emit } = events();
    const r = applyRegexGuardrails({ text: 'call 123 now', regexConfig: RULES, scope: 'userInput', emit, audit: { source: 'agent' }, direction: 'input' });
    assert.equal(r.action, 'redact');
    assert.equal(r.processedText, 'call [REDACTED: digits] now');
    assert.equal(r.ruleNames, 'digits');
    assert.equal(e.length, 1);
    assert.equal(e[0].type, 'content_redact');
    assert.deepEqual(e[0].data, { originalMessage: 'call 123 now', redactedMessage: 'call [REDACTED: digits] now', rules: 'digits', autoRedactSeconds: 5 });
    assert.equal(logCalls.length, 1);
    assert.equal(logCalls[0].action_taken, 'redacted');
    assert.equal(logCalls[0].violation_type, 'regex');
    assert.equal(logCalls[0].direction, 'input');
    assert.equal(logCalls[0].source, 'agent');
});

test('redact: redactBase differs from scan text (agent PII-tokenised copy)', () => {
    reset();
    const { e, emit } = events();
    // scan the raw text (has 123), redact into the already-processed copy
    const r = applyRegexGuardrails({ text: 'call 123', redactBase: 'call 123 [email_1]', regexConfig: RULES, scope: 'userInput', emit });
    assert.equal(r.action, 'redact');
    assert.equal(r.processedText, 'call [REDACTED: digits] [email_1]');
    assert.equal(e[0].data.originalMessage, 'call 123');       // originalMessage = scan text
    assert.equal(e[0].data.redactedMessage, 'call [REDACTED: digits] [email_1]');
});

test('block: emits guardrail_violation, logs blocked, processedText=base', () => {
    reset();
    const { e, emit } = events();
    const cfg = { ...RULES, action: 'delete' };
    const r = applyRegexGuardrails({ text: 'call 123', regexConfig: cfg, scope: 'userInput', emit, audit: { source: 'notebook' } });
    assert.equal(r.action, 'block');
    assert.equal(r.processedText, 'call 123');
    assert.equal(r.ruleNames, 'digits');
    assert.equal(e[0].type, 'guardrail_violation');
    assert.deepEqual(e[0].data, { rules: 'digits', autoDeleteSeconds: 5 });
    assert.equal(logCalls[0].action_taken, 'blocked');
    assert.equal(logCalls[0].source, 'notebook');
});

test('no audit → no log row (direct-chat contract)', () => {
    reset();
    const { emit } = events();
    const r = applyRegexGuardrails({ text: 'call 123', regexConfig: RULES, scope: 'userInput', emit });
    assert.equal(r.action, 'redact');
    assert.equal(logCalls.length, 0);
});

test('no emit provided → still redacts + returns (route without emitter)', () => {
    reset();
    const r = applyRegexGuardrails({ text: 'call 123', regexConfig: RULES, scope: 'userInput' });
    assert.equal(r.action, 'redact');
    assert.equal(r.processedText, 'call [REDACTED: digits]');
});

test.after(() => restore());
