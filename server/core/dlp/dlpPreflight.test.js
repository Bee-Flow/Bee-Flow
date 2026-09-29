/**
 * DB-free unit test for runDlpPreflight (M1 Step A).
 *
 * Stubs the three lazily-required deps (dlpRunner / decisionQueue /
 * guardrailEventStore) so no guard service and no DB are touched. Asserts the
 * exact SSE event names + payloads, the audit action_taken values, the
 * in-place message redaction, and the {blocked, outcome, reason} verdict — the
 * contract chatStream and directChat depend on.
 *
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 core/dlp/dlpPreflight.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── mutable fakes (set per test) ──────────────────────────────────────────
let scanResult;
let registerImpl;

const applyRedactionChoiceCalls = [];
const setPrefCalls = [];
const scanCalls = [];
const fakeDlpRunner = {
    scan: async (args) => { scanCalls.push(args); return scanResult; },
    applyRedactionChoice: (args) => {
        applyRedactionChoiceCalls.push(args);
        return { tokenizedText: 'hello [person_1]', tokenMap: { '[person_1]': 'Alice' } };
    },
    setConversationPref: (convId, choice) => setPrefCalls.push({ convId, choice }),
};

const auditCalls = [];
const fakeGuardrailEventStore = { logDlpDecision: async (row) => { auditCalls.push(row); } };
const fakeDecisionQueue = { register: (...a) => registerImpl(...a) };

const restore = installResolveStub({
    './dlpRunner': fakeDlpRunner,
    './decisionQueue': fakeDecisionQueue,
    '../../stores/guardrailEventStore': fakeGuardrailEventStore,
});

const { runDlpPreflight } = require('./dlpPreflight');

// ── helpers ───────────────────────────────────────────────────────────────
function freshCtx(overrides = {}) {
    const events = [];
    // The progress status line ("Protecting your data… part 3/6") is a phase
    // event wrapped around the scan, not part of the decision contract these
    // tests pin — collected separately so every case below still asserts the
    // DECISION events exactly, by name AND position. Asserted on its own in T10.
    const phases = [];
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello Alice' },
    ];
    return {
        events,
        phases,
        messages,
        base: {
            messages,
            resolvedShield: { dlpEnabled: true, dlpMode: 'auto_redact', showRawPayload: false },
            orgId: 'org1',
            conversationId: 'conv1',
            userId: 'u1',
            model: 'gpt-x',
            providerConfig: { providerType: 'openai', url: 'http://x', displayName: 'OpenAI' },
            emit: (type, data) => (type === 'phase' ? phases : events).push({ type, data }),
            audit: { organization_id: 'org1', user_id: 'u1', source: 'test' },
            ...overrides,
        },
    };
}
function reset() { auditCalls.length = 0; applyRedactionChoiceCalls.length = 0; setPrefCalls.length = 0; scanCalls.length = 0; }
function names(events) { return events.map(e => e.type); }

// ── T1: block never throws; emits dlp_blocked + audits blocked ─────────────
test('block: returns {blocked, reason:policy_block}, emits dlp_blocked, audits blocked, never throws', async () => {
    reset();
    const { base, events, messages } = freshCtx();
    scanResult = { action: 'block', reason: 'policy_block', provider: { displayName: 'OpenAI' }, findings: [{ label: 'name', category: 'pii', source: 'user', text: 'Alice' }], summary: { name: 1 } };
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'blocked', blocked: true, reason: 'policy_block' });
    assert.deepEqual(names(events), ['dlp_blocked']);
    assert.equal(events[0].data.reason, 'policy_block');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action_taken, 'blocked');
    assert.equal(auditCalls[0].violation_categories, 'name');
    assert.equal(auditCalls[0].conversation_id, 'conv1'); // injected from conversationId
    assert.equal(auditCalls[0].source, 'test');           // caller audit base preserved
    // message untouched on block
    assert.equal(messages[1].content, 'hello Alice');
});

// ── T2: auto-redact mutates message + returns redactedText/tokenMap/meta ────
test('auto-redact: mutates last user message, emits dlp_resolved(automatic:true), audits redacted', async () => {
    reset();
    const { base, events, messages } = freshCtx();
    scanResult = { action: 'redact', redactedText: 'hello [person_1]', tokenMap: { '[person_1]': 'Alice' }, provider: { displayName: 'OpenAI' }, findings: [], summary: { name: 1 } };
    const r = await runDlpPreflight(base);
    assert.equal(r.outcome, 'redacted');
    assert.equal(r.blocked, false);
    assert.equal(r.redactedText, 'hello [person_1]');
    assert.deepEqual(r.tokenMap, { '[person_1]': 'Alice' });
    assert.equal(messages[1].content, 'hello [person_1]');
    assert.deepEqual(r.userPrivacyMeta, { dlpRedactedCount: 1, dlpCategories: ['name'] });
    assert.equal(r.assistantTokenisationInfo.source, 'dlp');
    assert.equal(r.assistantTokenisationInfo.automatic, true);
    assert.deepEqual(names(events), ['dlp_resolved']);
    assert.equal(events[0].data.appliedChoice, 'redact');
    assert.equal(events[0].data.automatic, true);
    assert.equal(auditCalls[0].action_taken, 'redacted');
});

// ── T3: showRawPayload emits privacy_payload + privacy_token_map ────────────
test('auto-redact with showRawPayload: emits privacy_payload + privacy_token_map, stamps tokenisationInfo', async () => {
    reset();
    const { base, events } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'auto_redact', showRawPayload: true } });
    scanResult = { action: 'redact', redactedText: 'hello [person_1]', tokenMap: { '[person_1]': 'Alice' }, provider: { displayName: 'OpenAI' }, findings: [], summary: { name: 1 } };
    const r = await runDlpPreflight(base);
    assert.deepEqual(names(events), ['dlp_resolved', 'privacy_payload', 'privacy_token_map']);
    assert.equal(events[1].data.tokenizedPrompt, 'hello [person_1]');
    assert.equal(events[1].data.provider, 'gpt-x');
    assert.deepEqual(events[2].data.tokenMap, { '[person_1]': 'Alice' });
    assert.equal(r.assistantTokenisationInfo.tokenizedPrompt, 'hello [person_1]');
    assert.deepEqual(r.assistantTokenisationInfo.tokenMap, { '[person_1]': 'Alice' });
});

// ── T4: ask → redact ────────────────────────────────────────────────────────
test('ask→redact: emits dlp_preview then dlp_resolved(automatic:false), applies applyRedactionChoice', async () => {
    reset();
    const { base, events, messages } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = { action: 'ask', provider: { displayName: 'OpenAI' }, findings: [{ label: 'name', category: 'pii', source: 'user', text: 'Alice' }], summary: { name: 1 } };
    registerImpl = () => ({ decisionId: 'd1', promise: Promise.resolve({ choice: 'redact', rememberForConversation: false }) });
    const r = await runDlpPreflight(base);
    assert.equal(r.outcome, 'redacted');
    assert.equal(applyRedactionChoiceCalls.length, 1);
    assert.equal(applyRedactionChoiceCalls[0].text, 'hello Alice');
    assert.equal(messages[1].content, 'hello [person_1]');
    assert.deepEqual(names(events), ['dlp_preview', 'dlp_resolved']);
    assert.equal(events[0].data.decisionId, 'd1');
    assert.equal(events[0].data.findings[0].preview, 'Ali…');
    assert.equal(events[1].data.automatic, false);
});

// ── T5: ask → user block ────────────────────────────────────────────────────
test('ask→block: emits dlp_preview + dlp_blocked(user_blocked), returns blocked reason user_blocked', async () => {
    reset();
    const { base, events } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = { action: 'ask', provider: { displayName: 'OpenAI' }, findings: [], summary: {} };
    registerImpl = () => ({ decisionId: 'd2', promise: Promise.resolve({ choice: 'block' }) });
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'blocked', blocked: true, reason: 'user_blocked' });
    assert.deepEqual(names(events), ['dlp_preview', 'dlp_blocked']);
    assert.equal(events[1].data.reason, 'user_blocked');
    assert.equal(auditCalls[0].action_taken, 'blocked');
});

// ── T6: ask → timeout (promise rejects) ─────────────────────────────────────
test('ask→timeout: emits dlp_blocked(timeout), returns blocked reason ask_timeout, never throws', async () => {
    reset();
    const { base, events } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = { action: 'ask', provider: { displayName: 'OpenAI' }, findings: [], summary: {} };
    const timeoutErr = new Error('to'); timeoutErr.code = 'DLP_TIMEOUT';
    registerImpl = () => ({ decisionId: 'd3', promise: Promise.reject(timeoutErr) });
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'blocked', blocked: true, reason: 'ask_timeout' });
    assert.equal(events[1].type, 'dlp_blocked');
    assert.equal(events[1].data.reason, 'timeout');
});

// ── T7: ask → allow ─────────────────────────────────────────────────────────
test('ask→allow: emits dlp_resolved(allow), audits allowed, returns allow, message untouched', async () => {
    reset();
    const { base, events, messages } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = { action: 'ask', provider: { displayName: 'OpenAI' }, findings: [], summary: { name: 1 } };
    registerImpl = () => ({ decisionId: 'd4', promise: Promise.resolve({ choice: 'allow', rememberForConversation: true }) });
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'allow', blocked: false });
    assert.deepEqual(names(events), ['dlp_preview', 'dlp_resolved']);
    assert.equal(events[1].data.appliedChoice, 'allow');
    assert.equal(auditCalls[0].action_taken, 'allowed');
    assert.equal(messages[1].content, 'hello Alice');
    // rememberForConversation:true + choice!=='block' → setConversationPref called
    assert.deepEqual(setPrefCalls, [{ convId: 'conv1', choice: 'allow' }]);
});

// ── T8: plain allow (scan returns action:'allow') → no events ────────────────
test('allow (auto): no events, no audit, returns allow', async () => {
    reset();
    const { base, events } = freshCtx();
    scanResult = { action: 'allow', provider: { displayName: 'OpenAI' }, findings: [], summary: {} };
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'allow', blocked: false });
    assert.equal(events.length, 0);
    assert.equal(auditCalls.length, 0);
});

// ── T9: scan failed (fail-open) → audit scan_failed ─────────────────────────
test('scan_failed: audits scan_failed, returns scan_failed, no user-facing events', async () => {
    reset();
    const { base, events } = freshCtx();
    scanResult = { action: 'allow', scanStatus: 'failed', provider: null, findings: [], summary: {} };
    const r = await runDlpPreflight(base);
    assert.deepEqual(r, { outcome: 'scan_failed', blocked: false });
    assert.equal(events.length, 0);
    assert.equal(auditCalls[0].action_taken, 'scan_failed');
    assert.equal(auditCalls[0].violation_categories, 'scan_failed');
});

// ── T10: the scan reports progress instead of going silent ─────────────────
// A big paste is scanned window by window against a CPU model and takes
// minutes. Emitting nothing for that whole time is indistinguishable from a
// hang, and long enough for a reverse proxy to drop the stream.
test('the scan is wrapped in a privacy_scan phase that always ends', async () => {
    reset();
    const { base, phases } = freshCtx();
    scanResult = { action: 'allow', provider: null, findings: [], summary: {} };
    await runDlpPreflight(base);

    assert.deepEqual(phases.map(p => p.data.status), ['start', 'end'],
        'the status line must be closed even when nothing was found');
    assert.equal(phases[0].data.stage, 'privacy_scan', 'a short message is a one-part scan');
});

test('a multi-window scan reports which part it is on', async () => {
    reset();
    const { MAX_REQUEST_CHARS } = require('../privacy/piiDetection');
    const big = 'x'.repeat(MAX_REQUEST_CHARS * 3);
    const { base, phases } = freshCtx();
    base.messages = [{ role: 'user', content: big }];
    // Drive the progress callback the way a real windowed scan does.
    fakeDlpRunner.scan = async ({ onProgress }) => {
        onProgress({ done: 1, total: 4 });
        onProgress({ done: 2, total: 4 });
        onProgress({ done: 4, total: 4 });   // last window reports no new part
        return { action: 'allow', provider: null, findings: [], summary: {} };
    };
    try {
        await runDlpPreflight(base);
    } finally {
        fakeDlpRunner.scan = async (args) => { scanCalls.push(args); return scanResult; };
    }

    const starts = phases.filter(p => p.data.status === 'start');
    assert.ok(starts.every(p => p.data.stage === 'privacy_scan_large'));
    assert.deepEqual(starts.map(p => p.data.detail), ['1/4', '2/4', '3/4'],
        'the detail names the part being scanned, and never announces a part that will not be scanned');
    assert.equal(phases.at(-1).data.status, 'end');
});

// ── T11: dlp_preview carries the rich per-finding shape ─────────────────────
test('ask: dlp_preview carries reviewText + full per-finding offset/length/confidence/band', async () => {
    reset();
    const { base, events } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false, piiDetectionConfidenceThreshold: 0.7 } });
    scanResult = {
        action: 'ask',
        provider: { displayName: 'OpenAI' },
        findings: [{ label: 'name', category: 'Person', source: 'pii', text: 'Alice', offset: 6, length: 5, confidence: 0.92 }],
        summary: { name: 1 },
    };
    registerImpl = () => ({ decisionId: 'd5', promise: Promise.resolve({ choice: 'allow' }) });
    await runDlpPreflight(base);
    const preview = events[0].data;
    assert.equal(preview.reviewText, 'hello Alice');
    const f = preview.findings[0];
    assert.equal(f.id, 'pii_0');
    assert.equal(f.text, 'Alice', 'full match text, not the old 3-char truncation');
    assert.equal(f.preview, 'Ali…', 'legacy field kept for one release');
    assert.equal(f.offset, 6);
    assert.equal(f.length, 5);
    assert.equal(f.confidence, 0.92);
    assert.equal(f.confidenceBand, 'high');
});

test('ask: a custom-term finding (no confidence) gets a null band, not a crash', async () => {
    reset();
    const { base, events } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = {
        action: 'ask',
        provider: { displayName: 'OpenAI' },
        findings: [{ label: 'ProjectCode', category: 'Custom', source: 'custom', text: 'Alice', offset: 6, length: 5 }],
        summary: { ProjectCode: 1 },
    };
    registerImpl = () => ({ decisionId: 'd6', promise: Promise.resolve({ choice: 'allow' }) });
    await runDlpPreflight(base);
    assert.equal(events[0].data.findings[0].confidence, null);
    assert.equal(events[0].data.findings[0].confidenceBand, null);
});

// ── T12: manual additions merge into the same redaction path ────────────────
test('ask→redact with manualAdditions: re-slices server-side text, merges into applyRedactionChoice, audits user_added(N)', async () => {
    reset();
    const { base } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    // "hello Alice" — user manually marks "hello" (offset 0, length 5) as PII
    // the detector missed, in addition to the one auto finding on "Alice".
    scanResult = {
        action: 'ask',
        provider: { displayName: 'OpenAI' },
        findings: [{ label: 'name', category: 'Person', source: 'pii', text: 'Alice', offset: 6, length: 5, confidence: 0.9 }],
        summary: { name: 1 },
    };
    registerImpl = () => ({ decisionId: 'd7', promise: Promise.resolve({ choice: 'redact', manualAdditions: [{ offset: 0, length: 5 }] }) });
    const r = await runDlpPreflight(base);
    assert.equal(r.outcome, 'redacted');
    assert.equal(applyRedactionChoiceCalls.length, 1);
    const sentFindings = applyRedactionChoiceCalls[0].findings;
    assert.equal(sentFindings.length, 2, 'auto finding + the manual one, same call');
    const manual = sentFindings.find(f => f.source === 'manual');
    assert.ok(manual, 'manual finding forwarded to applyRedactionChoice');
    assert.equal(manual.text, 'hello', 're-sliced from the server\'s own copy of the text, not trusted from the client');
    assert.equal(manual.category, 'UserMarked');
    assert.equal(auditCalls[0].violation_categories, 'name, user_added(1)');
});

test('ask→redact: an out-of-bounds manualAddition is dropped, not applied', async () => {
    reset();
    const { base } = freshCtx({ resolvedShield: { dlpEnabled: true, dlpMode: 'ask', showRawPayload: false } });
    scanResult = { action: 'ask', provider: { displayName: 'OpenAI' }, findings: [], summary: {} };
    // "hello Alice" is 11 chars — offset 100 is well past the end.
    registerImpl = () => ({ decisionId: 'd8', promise: Promise.resolve({ choice: 'redact', manualAdditions: [{ offset: 100, length: 5 }] }) });
    const r = await runDlpPreflight(base);
    assert.equal(r.outcome, 'redacted');
    assert.deepEqual(applyRedactionChoiceCalls[0].findings, [], 'the out-of-bounds addition must not reach the redaction path');
    assert.equal(auditCalls[0].violation_categories, null, 'no user_added suffix when nothing valid was added');
});

// ── T14: hasAttachments forwarded to dlpRunner.scan (redundant-pause fix) ───
test('hasAttachments defaults to false and is forwarded verbatim to dlpRunner.scan', async () => {
    reset();
    const { base } = freshCtx();
    scanResult = { action: 'allow', provider: null, findings: [], summary: {} };
    await runDlpPreflight(base);
    assert.equal(scanCalls[0].hasAttachments, false);
});

test('hasAttachments:true is forwarded to dlpRunner.scan when the caller passes it', async () => {
    reset();
    const { base } = freshCtx({ hasAttachments: true });
    scanResult = { action: 'allow', provider: null, findings: [], summary: {} };
    await runDlpPreflight(base);
    assert.equal(scanCalls[0].hasAttachments, true);
});

test.after(() => restore());
