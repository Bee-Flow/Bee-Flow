// @typecheck strict
/**
 * The six rules behind GET /api/studio/attention, each on its own.
 *
 * Every evaluator is PURE — plain data in, findings out — so this file drives
 * them with object literals and never opens a database or a socket. The route's
 * own contract (gates, allSettled, `unavailable`, `complete`) is pinned next
 * door in attention.test.js.
 *
 * What is pinned here is the difference the whole screen hangs on: for every
 * rule, "looked and found nothing" and "could not look" produce DIFFERENT
 * results — the first is zero findings and no gap, the second is a NAMED gap,
 * which is what turns `complete` false one level up. A rule that turned an
 * unreadable input into a clean bill would pass a test that only checked the
 * happy path, so each rule is fed its own kind of unknown.
 *
 * The rules that run module projects' own code (the App Studio validation through
 * buildCompleteness, the empty-base finding, the deep links) are in
 * attentionChecks.projects.test.js, which that module owns.
 *
 * Run: node --test --test-reporter=tap routes/studio/attentionChecks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    SOURCE_KEYS,
    evaluateAgentNoKb,
    evaluateAutomationFailing,
    evaluateSolutionBlocked,
    evaluateKbSourceError,
    documentCountOf,
    agentConfigOf,
    leadingErrorStreak,
    groupRunsByAutomation,
} = require('./attentionChecks');
test('the register names exactly the six sources', () => {
    assert.deepStrictEqual([...SOURCE_KEYS], [
        'appValidation', 'agentNoKb', 'kbEmptyInUse',
        'automationFailing', 'solutionBlocked', 'kbSourceError',
    ]);
});

// ── 2. Agents ───────────────────────────────────────────────────────────────

test('a published agent with no knowledge base is a warning; one with a base is not', () => {
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [
            { id: 'ag1', name: 'Helpdesk', config: JSON.stringify({ knowledge_base_ids: [] }) },
            { id: 'ag2', name: 'Grounded', config: JSON.stringify({ knowledge_base_ids: ['kb1'] }) },
        ],
        gaps: [],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'agent.no_knowledge_base');
    assert.strictEqual(findings[0].severity, 'warning');
    assert.strictEqual(findings[0].targetRef.id, 'ag1');
    assert.match(findings[0].message, /"Helpdesk"/);
});

test('de camelCase-spelling grondt hem NIET — knowledgeSearch leest die sleutel niet', () => {
    // core/agentRuntime/knowledgeSearch.js does `agent.config?.knowledge_base_ids
    // || []`. A row that carries only `knowledgeBaseIds` therefore searches zero knowledge bases every turn; booking it here as grounded would keep that agent off
    // the list while it has precisely the problem that the list reports.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag3', name: 'CamelCase', config: { knowledgeBaseIds: ['kb2'] } }],
        gaps: [],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].targetRef.id, 'ag3');
});

test('an agent whose config cannot be read is a GAP, not an agent without a base', () => {
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag9', name: 'Corrupt', config: '{not json' }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, [], 'unreadable wiring is not absent wiring');
    assert.deepStrictEqual(gaps, ['agents:config']);
});

test('an agent with no agents at all is checked-and-empty', () => {
    assert.deepStrictEqual(evaluateAgentNoKb({ agents: [], gaps: [] }), { findings: [], gaps: [] });
});

test('a table grant grounds an agent too — the rule is not KB-only', () => {
    // This agent really could look something up, and was reported here until A5 as
    // "answers from the model alone". The criterion now lives in
    // core/agentRuntime/agentGrounding.js, which the overview's card footer also reads — so this list and that card cannot diverge.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag4', name: 'Tables', config: JSON.stringify({ tools: { datatables: { t1: {} } } }) }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, [], 'een tabel is een bron');
    assert.deepStrictEqual(gaps, []);
});

test('websearch aan is GEEN grond — het veld stuurt niets aan in het chatpad', () => {
    // `config.enabledIntegrations` is read by nothing in the chat path, and
    // the R4 backfill (stores/agent/initSchema.js) has set 'agent-search' in EVERY
    // older row. If that counted as grounding, this notice would disappear for almost every existing agent without anything about it having changed —
    // and on a self-host without a search profile it demonstrably answers from the model alone.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag5', name: 'Web', config: JSON.stringify({ enabledIntegrations: ['agent-search'] }) }],
        gaps: [],
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'agent.no_knowledge_base');
    assert.deepStrictEqual(gaps, []);
});

test('an agent whose knowledge_base_ids is not a list is a GAP, not an ungrounded agent', () => {
    // `asArray` silently made `[]` here, and therefore an accusation about
    // an agent whose wiring nobody could read.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag6', name: 'Odd', config: JSON.stringify({ knowledge_base_ids: 'kb1' }) }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['agents:config']);
});

// ── 1, 3. Apps and empty knowledge bases in use: module projects' rules (attentionChecks.projects.test.js)

// ── 4. Failing automations ─────────────────────────────────────────────────────

const runRow = (/** @type {string} */ id, /** @type {string} */ status, title = 'Invoice reminder') => ({ automationId: id, title, status });

test('the streak is LEADING — a success in between resets it', () => {
    const { findings } = evaluateAutomationFailing({
        runs: [
            // Newest first: one failure, then a success, then a long-gone streak.
            runRow('a1', 'error'), runRow('a1', 'success'),
            runRow('a1', 'error'), runRow('a1', 'error'), runRow('a1', 'error'),
        ],
    });
    assert.deepStrictEqual(findings, [], 'an automation that recovered is not failing');
});

test('an unfinished run is not a failure — it stops the streak instead of extending it', () => {
    const { findings } = evaluateAutomationFailing({
        runs: [runRow('a1', 'running'), runRow('a1', 'error'), runRow('a1', 'error'), runRow('a1', 'error')],
    });
    assert.deepStrictEqual(findings, [], 'an automation that is running right now is not reported');
});

test('no runs at all is checked-and-empty, not a gap', () => {
    assert.deepStrictEqual(evaluateAutomationFailing({ runs: [] }), { findings: [], gaps: [] });
});

// ── 5. Blocked Solutions ────────────────────────────────────────────────────

const project = { id: 'pr1', name: 'Invoice rollout' };

test('a blocked, fully-checked Solution is one error row carrying the copied verdict', () => {
    const { findings, gaps } = evaluateSolutionBlocked({
        checked: [{ project, result: { blocked: true, complete: true, findings: [{ severity: 'error' }, { severity: 'warning' }] } }],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'solution.blocked');
    assert.strictEqual(findings[0].severity, 'error');
    assert.match(findings[0].message, /2 findings need a person/);
});

test('a healthy Solution produces nothing', () => {
    const { findings, gaps } = evaluateSolutionBlocked({
        checked: [{ project, result: { blocked: false, complete: true, findings: [] } }],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, []);
});

test('a Solution that could not be fully checked is a GAP and says so in its own words', () => {
    const { findings, gaps } = evaluateSolutionBlocked({
        // `blocked` is true here only because UNKNOWN BLOCKS in completeness.js.
        checked: [{ project, result: { blocked: true, complete: false, unavailable: ['apps'], findings: [] } }],
    });
    assert.deepStrictEqual(gaps, ['solutions:pr1']);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'solution.check_incomplete');
    assert.strictEqual(findings[0].severity, 'warning');
    assert.match(findings[0].message, /could not be checked completely/);
    assert.doesNotMatch(findings[0].message, /findings need/, 'never accuse a Solution nobody could read');
});

test('a Solution whose check threw is a gap and nothing else', () => {
    const { findings, gaps } = evaluateSolutionBlocked({ checked: [{ project, result: null }] });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['solutions:pr1']);
});

// ── 6. Knowledge sources in error ───────────────────────────────────────────

test('a base with failing sources is one warning row per base', () => {
    const { findings, gaps } = evaluateKbSourceError({
        knowledgeBases: [{ id: 'kb1', name: 'Handbook' }, { id: 'kb2', name: 'Policies' }],
        errorCounts: new Map([['kb1', 2]]),
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'kb_source.refresh_failed');
    assert.strictEqual(findings[0].severity, 'warning');
    assert.strictEqual(findings[0].targetRef.id, 'kb1');
    assert.match(findings[0].message, /2 sources that could not refresh/);
});

test('a single failing source is worded singular, and a plain object works like a Map', () => {
    const { findings } = evaluateKbSourceError({
        knowledgeBases: [{ id: 'kb1', name: 'Handbook' }],
        errorCounts: { kb1: 1 },
    });
    assert.match(findings[0].message, /1 source that could not refresh/);
});

test('bases with no failing source produce nothing', () => {
    assert.deepStrictEqual(evaluateKbSourceError({
        knowledgeBases: [{ id: 'kb1', name: 'Handbook' }],
        errorCounts: new Map(),
    }), { findings: [], gaps: [] });
});

test('an ABSENT count map is a gap, not a clean bill over the knowledge sources', () => {
    // The store rejects rather than answering `undefined` (stores/kbSources.js
    // says so in its own header), so this path is guarded by an agreement made
    // elsewhere — and this function is exported and tested as a rule on its
    // own, so it has to hold on its own. A missing map read as "every base has
    // zero failing sources" is a clean statement about knowledge sources
    // nobody counted.
    const b = evaluateKbSourceError({ knowledgeBases: [{ id: 'kb1', name: 'Handbook' }] });
    assert.deepStrictEqual(b.findings, []);
    assert.deepStrictEqual(b.gaps, ['kbSources:counts']);
});

// ── One bad row must not take its source down ───────────────────────────────

test('a row that cannot be BUILT is a gap — the rest of the source still reports', () => {
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [
            // An id no Finding can carry (targetRef.id must be a string, a
            // number or null) — one malformed row out of two, both of which
            // are otherwise findings.
            { id: { nope: true }, name: 'Broken row', config: '{}' },
            { id: 'ag2', name: 'Helpdesk', config: '{}' },
        ],
    });
    assert.strictEqual(findings.length, 1, 'the good row survives its neighbour');
    assert.strictEqual(findings[0].targetRef.id, 'ag2');
    assert.deepStrictEqual(gaps, ['agents:row'], 'and the lost row is NAMED, never dropped quietly');
});

// ── The helpers the rules are built from ────────────────────────────────────

test('documentCountOf keeps null and 0 apart', () => {
    assert.strictEqual(documentCountOf({ document_count: 0 }), 0);
    assert.strictEqual(documentCountOf({ documentCount: 5 }), 5);
    assert.strictEqual(documentCountOf({ document_count: '7' }), 7);
    assert.strictEqual(documentCountOf({}), null, 'absent is unknown, not empty');
    assert.strictEqual(documentCountOf({ document_count: null }), null);
    assert.strictEqual(documentCountOf({ document_count: 'lots' }), null);
    assert.strictEqual(documentCountOf(null), null);
});

test('agentConfigOf returns null ONLY when the config cannot be read', () => {
    assert.deepStrictEqual(agentConfigOf({ config: '{"a":1}' }), { a: 1 });
    assert.deepStrictEqual(agentConfigOf({ config: { a: 1 } }), { a: 1 });
    assert.deepStrictEqual(agentConfigOf({ config: '' }), {}, 'an empty config is readable and empty');
    assert.deepStrictEqual(agentConfigOf({}), {});
    assert.strictEqual(agentConfigOf({ config: '{oops' }), null);
    assert.strictEqual(agentConfigOf({ config: '[1,2]' }), null, 'an array is not a config');
});

test('leadingErrorStreak counts only the unbroken head', () => {
    assert.strictEqual(leadingErrorStreak(['error', 'error', 'success', 'error']), 2);
    assert.strictEqual(leadingErrorStreak([]), 0);
    assert.strictEqual(leadingErrorStreak(['success']), 0);
    assert.strictEqual(leadingErrorStreak(null), 0);
});

test('groupRunsByAutomation preserves arrival order and drops rows with no id', () => {
    const groups = groupRunsByAutomation([
        { automationId: 'a1', title: null, status: 'error' },
        { automationId: 'a1', title: 'Named later', status: 'success' },
        { status: 'error' },
    ]);
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].statuses, ['error', 'success']);
    assert.strictEqual(groups[0].title, 'Named later');
});
