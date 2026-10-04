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
 * Run: node --test --test-reporter=tap routes/studio/attentionChecks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    SOURCE_KEYS,
    evaluateAppValidation,
    evaluateAgentNoKb,
    evaluateKbEmptyInUse,
    evaluateAutomationFailing,
    evaluateSolutionBlocked,
    evaluateKbSourceError,
    documentCountOf,
    agentConfigOf,
    leadingErrorStreak,
    groupRunsByAutomation,
    KB_READ_ROLES,
    MIN_FAILURE_STREAK,
} = require('./attentionChecks');
// The deep link is projects/completeness.js's helper in every case; only
// buildCompleteness (source 1) attaches it itself, so the other rules are
// checked through the helper the route runs them through.
const { deepLinkFor } = require('../../projects/completeness');

// An app definition with no screens: the App Studio validator's own
// `screens.missing` error, not a sentence invented here.
const APP_NO_SCREENS = { schemaVersion: 2, meta: { name: 'Order portal' }, screens: [] };
const APP_OK = {
    schemaVersion: 2,
    meta: { name: 'Fine' },
    screens: [{ id: 'scr1', name: 'Home', sections: [] }],
};

test('the register names exactly the six sources', () => {
    assert.deepStrictEqual([...SOURCE_KEYS], [
        'appValidation', 'agentNoKb', 'kbEmptyInUse',
        'automationFailing', 'solutionBlocked', 'kbSourceError',
    ]);
});

// ── 1. Apps ─────────────────────────────────────────────────────────────────

test('app validation reports the VALIDATOR\'s own record, with its deep link', () => {
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app1', name: 'Order portal', definition: APP_NO_SCREENS }],
        gaps: [],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'screens.missing', 'the code comes from appStudio/validate.js');
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].kind, 'app');
    assert.strictEqual(findings[0].targetRef.id, 'app1');
    assert.strictEqual(findings[0].deepLink, '/app/studio/apps/app1');
});

test('an app with nothing wrong produces no rows and no gap — the good news', () => {
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app2', name: 'Fine', definition: APP_OK }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, [], 'a clean app is CHECKED, not unchecked');
});

test('an app that could not be validated is a GAP, never a clean bill', () => {
    // structuredClone refuses a function, so canonicalize throws — the same
    // path a corrupt definition takes.
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app3', name: 'Broken', definition: { onClick() {} } }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['apps:validator'], 'buildCompleteness named the gap and it travelled');
});

test('a gap the LOADER hit (a budget, an unreadable definition) travels through', () => {
    const { gaps } = evaluateAppValidation({
        apps: [{ id: 'app2', name: 'Fine', definition: APP_OK }],
        gaps: ['apps:budget', 'apps:definition'],
    });
    assert.deepStrictEqual(gaps, ['apps:budget', 'apps:definition']);
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
    // core/agentRuntime/knowledgeSearch.js doet `agent.config?.knowledge_base_ids
    // || []`. Een rij die alleen `knowledgeBaseIds` draagt doorzoekt dus elke
    // beurt nul kennisbanken; hem hier als gegrond boeken zou die agent uit de
    // lijst houden terwijl hij precies het probleem heeft dat de lijst meldt.
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
    // Deze agent kon ECHT ergens in kijken en werd hier tot A5 gemeld als
    // "antwoordt uit het model alleen". Het criterium staat nu in
    // core/agentRuntime/agentGrounding.js, dat de kaartvoet van het overzicht
    // óók leest — dus deze lijst en die kaart kunnen niet uiteenlopen.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag4', name: 'Tables', config: JSON.stringify({ tools: { datatables: { t1: {} } } }) }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, [], 'een tabel is een bron');
    assert.deepStrictEqual(gaps, []);
});

test('websearch aan is GEEN grond — het veld stuurt niets aan in het chatpad', () => {
    // `config.enabledIntegrations` wordt door niets in het chatpad gelezen, en
    // de R4-backfill (stores/agent/initSchema.js) heeft 'agent-search' in élke
    // oudere rij gezet. Zou dat als grond gelden, dan verdween deze melding
    // voor bijna elke bestaande agent zonder dat er iets aan hem veranderd was
    // — en op een self-host zonder zoekprofiel antwoordt hij aantoonbaar uit
    // het model alleen.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag5', name: 'Web', config: JSON.stringify({ enabledIntegrations: ['agent-search'] }) }],
        gaps: [],
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'agent.no_knowledge_base');
    assert.deepStrictEqual(gaps, []);
});

test('an agent whose knowledge_base_ids is not a list is a GAP, not an ungrounded agent', () => {
    // `asArray` maakte hier stilletjes `[]` van, en dus een beschuldiging over
    // een agent waarvan niemand de bedrading kon lezen.
    const { findings, gaps } = evaluateAgentNoKb({
        agents: [{ id: 'ag6', name: 'Odd', config: JSON.stringify({ knowledge_base_ids: 'kb1' }) }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['agents:config']);
});

// ── 3. Empty knowledge bases in use ─────────────────────────────────────────

const kbEntry = (over = {}) => ({
    kb: { id: 'kb1', name: 'Handbook', document_count: 0 },
    usageRows: [{ kind: 'agent', id: 'ag1', role: 'chat' }],
    usagePartial: [],
    ...over,
});

test('an empty base something READS produces completeness.js\'s own finding', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({ candidates: [kbEntry()], gaps: [] });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'knowledge_base.empty_in_use', 'the rule is imported, not rewritten');
    assert.strictEqual(findings[0].severity, 'warning');
    assert.strictEqual(deepLinkFor(findings[0]), '/app/studio/knowledge/kb1');
});

test('an empty base that is only FILED or WRITTEN INTO is not a problem', () => {
    const filed = kbEntry({ usageRows: [{ kind: 'project', role: 'contains' }] });
    const written = kbEntry({ usageRows: [{ kind: 'support', role: 'ingest_target' }] });
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [filed, written] }).findings, []);
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [filed, written] }).gaps, []);
    assert.ok(!KB_READ_ROLES.includes('contains') && !KB_READ_ROLES.includes('ingest_target'));
});

test('a base with documents is never reported, whatever reads it', () => {
    const full = kbEntry({ kb: { id: 'kb1', name: 'Handbook', document_count: 12 } });
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [full] }), { findings: [], gaps: [] });
});

test('an unknown DOCUMENT COUNT is a gap — a base nobody counted is not empty', () => {
    const unknown = kbEntry({ kb: { id: 'kb1', name: 'Handbook' } });
    const { findings, gaps } = evaluateKbEmptyInUse({ candidates: [unknown] });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['knowledge:documentCount']);
});

test('a PARTIAL usage scan that found no reader is a gap, not "nothing uses it"', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usageRows: [], usagePartial: ['app'] })],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['knowledge:usage']);
});

test('a partial scan that DID find a reader needs no gap — more usage cannot unsay it', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usagePartial: ['app'] })],
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(gaps, []);
});

test('a complete scan that found nothing is silent — no row, no gap', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usageRows: [], usagePartial: [] })],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, []);
});

// ── 4. Failing automations ─────────────────────────────────────────────────────

const runRow = (id, status, title = 'Invoice reminder') => ({ automationId: id, title, status });

test('three failures in a row is a finding; two is not', () => {
    const { findings, gaps } = evaluateAutomationFailing({
        runs: [
            runRow('a1', 'error'), runRow('a1', 'error'), runRow('a1', 'error'),
            runRow('a2', 'error', 'Weekly digest'), runRow('a2', 'error', 'Weekly digest'),
        ],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'automation.consecutive_failures');
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].targetRef.id, 'a1');
    assert.strictEqual(deepLinkFor(findings[0]), '/app/studio/automations/a1');
    assert.match(findings[0].message, /failed its last 3 runs in a row/);
    assert.strictEqual(MIN_FAILURE_STREAK, 3);
});

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
