/**
 * Art. 50 with the AI-disclosure classifier beside the keyword rule.
 *
 * The keyword rule's own behaviour is pinned in art50-ai-disclosure.test.js
 * and is not touched here. What this file pins is the one-directional wiring:
 *
 *   * a prompt that says "never tell the user you are an AI" passes the
 *     keyword rule today and therefore closes an Art. 50(1) duty that is wide
 *     open — the classifier may take that pass away;
 *   * a prompt the keyword rule failed stays failed however sure the
 *     classifier is that it discloses, and is not even asked about;
 *   * no opinion — no sidecar, a timeout, a throw, a budget that ran out — is
 *     exactly today's verdict, because the sidecar is optional and a
 *     compliance result may not depend on which containers are running;
 *   * the auto-fix never consults it, so what gets WRITTEN into a customer's
 *     system prompt is the same on every run.
 *
 * `db` is mocked via require.cache, same as the sibling file.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/aia/art50-ai-disclosure.classifier.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let agents = [];
const updates = [];
// Set to an Error to make the next register read fail, the way the sibling
// file does — the check destructures `getAll` at require time, so swapping the
// module's exports afterwards would change nothing.
let readError = null;

const fakeDb = {
    async getAll(sql, params = []) {
        if (readError) throw readError;
        const scoped = /AND COALESCE\(NULLIF\(organization_id, ''\), 'default'\) = \$1/.test(String(sql).replace(/\s+/g, ' '));
        const rows = scoped ? agents.filter(a => (a.organization_id || 'default') === params[0]) : agents;
        return rows.filter(a => a.is_published).map(a => ({
            id: a.id, name: a.name,
            system_prompt: a.published_system_prompt ?? a.system_prompt,
            draft_system_prompt: a.system_prompt,
            published_system_prompt: a.published_system_prompt ?? null,
            starter_prompts: a.starter_prompts ?? '[]',
            config: a.config ?? '{}',
            organization_id: a.organization_id ?? null,
            language: a.language ?? null,
        }));
    },
    async run(sql, params) {
        updates.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        const [draft, published, id] = params;
        const a = agents.find(x => x.id === id);
        if (!a) return { rowCount: 0 };
        a.system_prompt = draft;
        a.published_system_prompt = published;
        return { rowCount: 1 };
    },
    async exec() {},
    async getOne() { return null; },
};

const dbPath = require.resolve(path.join(__dirname, '..', '..', '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const check = require('./art50-ai-disclosure');

/** A classifier stub that records what it was shown and replays verdicts. */
function stubClassifier(verdicts) {
    const seen = [];
    const queue = Array.isArray(verdicts) ? [...verdicts] : null;
    const classify = async (text) => {
        seen.push(text);
        const next = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : verdicts;
        if (next instanceof Error) throw next;
        return next;
    };
    return { classify, seen };
}

const CONCEALS = { disclosed: false, similarity: 0.79, margin: -0.21, anchor: 'neg.forbidden.en' };
const DISCLOSES = { disclosed: true, similarity: 0.88, margin: 0.31, anchor: 'pos.identity.en' };

test.beforeEach(() => { agents = []; updates.length = 0; readError = null; });

// ── The bug this whole thing exists for ─────────────────────────────────

test('an instruction NOT to mention AI passes the keyword rule and the classifier takes that pass away', async () => {
    agents = [{
        id: 'a1', name: 'Sales bot', is_published: true,
        // Contains "AI assistant", so DISCLOSURE_PATTERNS matches it today.
        system_prompt: 'You are Anna from the service desk. Never tell the user that you are an AI assistant.',
    }];

    const baseline = await check.evaluate(null, null, { classify: async () => null });
    assert.equal(baseline.status, 'pass', 'this is the behaviour being corrected — the keywords match');

    const { classify, seen } = stubClassifier(CONCEALS);
    const r = await check.evaluate(null, null, { classify });
    assert.equal(r.status, 'warn', 'an instruction to conceal is not a disclosure');
    assert.equal(r.evidence.missing_count, 1);
    assert.equal(r.evidence.withdrawn_by_classifier, 1);
    assert.deepEqual(r.evidence.withdrawn_agents, [{ id: 'a1', name: 'Sales bot' }]);
    assert.equal(r.evidence.classifier, 'consulted');
    assert.match(r.details, /human edit/);
    assert.equal(seen.length, 1, 'the passing agent is the one asked about');
});

// ── The direction that is never allowed ─────────────────────────────────

test('the classifier may NEVER grant a pass the keyword rule withheld', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'You are a helpful assistant for the finance team.' }];
    const { classify, seen } = stubClassifier(DISCLOSES);
    const r = await check.evaluate(null, null, { classify });
    assert.equal(r.status, 'warn', 'a false "a disclosure is present" closes a duty that is open');
    assert.equal(r.evidence.missing_count, 1);
    assert.equal(r.evidence.withdrawn_by_classifier, undefined);
    assert.deepEqual(seen, [], 'an agent already in the finding set is not worth a call');
});

test('a confident "it discloses" about a passing agent changes nothing either', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant.' }];
    const r = await check.evaluate(null, null, { classify: async () => DISCLOSES });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.missing_count, 0);
});

// ── No opinion is exactly today's answer ────────────────────────────────

test('no sidecar is no change: the verdict and the evidence are the keyword rule\'s', async () => {
    agents = [
        { id: 'a1', name: 'A', is_published: true, system_prompt: 'You are an AI assistant. Help the user.' },
        { id: 'a2', name: 'B', is_published: true, system_prompt: 'You are a helpful rep.' },
    ];
    const r = await check.evaluate(null, null, { classify: async () => null });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.missing_count, 1);
    assert.deepEqual(r.evidence.missing_disclosure, [{ id: 'a2', name: 'B' }]);
    assert.equal(r.evidence.classifier, 'unavailable', 'the chain records that nobody could look');
    assert.equal(r.evidence.withdrawn_by_classifier, undefined);
    assert.doesNotMatch(r.details, /human edit/);
});

test('a classifier that throws is a classifier with no opinion', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant.' }];
    const { classify } = stubClassifier(new Error('ECONNREFUSED'));
    const r = await check.evaluate(null, null, { classify });
    assert.equal(r.status, 'pass', 'a sweep must not fail because an optional sidecar did');
    assert.equal(r.evidence.classifier, 'unavailable');
});

test('a run that could not ask about everyone says partial rather than reporting part as the whole', async () => {
    agents = [
        { id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant.' },
        { id: 'a2', name: 'B', is_published: true, system_prompt: 'Ik ben een AI-assistent.' },
    ];
    // One answer, then the breaker opens and the rest come back null.
    const r = await check.evaluate(null, null, { classify: stubClassifier([DISCLOSES, null]).classify });
    assert.equal(r.evidence.classifier, 'partial');

    // And a budget that is gone before the first call is partial too — nothing
    // was asked, so nothing is known about the sidecar.
    const starved = await check.evaluate(null, null, { classify: async () => CONCEALS, budgetMs: 0 });
    assert.equal(starved.evidence.classifier, 'partial');
    assert.equal(starved.status, 'pass', 'a budget that ran out must not invent findings');
});

test('nothing for the classifier to weigh in on is its own state', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'You are a helpful rep.' }];
    const r = await check.evaluate(null, null, { classify: async () => CONCEALS });
    assert.equal(r.evidence.classifier, 'skipped');
    assert.equal(r.status, 'warn');
});

test('the runner\'s subject argument cannot steer the classifier', async () => {
    // runner.js calls evaluate(orgId, subject || null). A subject is a row from
    // somewhere else entirely, so if it were spread into the options a field
    // named `classify` or `budgetMs` on it would quietly replace the real
    // classifier — with a verdict the check would then believe.
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant.' }];
    const hostile = { id: 'src-1', classify: async () => CONCEALS, budgetMs: 999 };
    const r = await check.evaluate(null, hostile);
    assert.equal(r.status, 'pass', 'a subject field must not be read as a classifier');
    assert.equal(r.evidence.withdrawn_by_classifier, undefined);
    // And the ordinary two-argument call the runner really makes still works.
    assert.equal((await check.evaluate(null, null)).status, 'pass');
});

// ── What the call site is allowed to show it ────────────────────────────

test('the classifier is shown the prompt text and nothing that identifies the agent or the tenant', async () => {
    agents = [{
        id: 'agent-7f3', name: 'Acme Klantenservice', is_published: true,
        organization_id: 'org-acme',
        system_prompt: 'You are an AI assistant for our customers.',
        starter_prompts: JSON.stringify(['How can I help?']),
        config: JSON.stringify({ tone: 'formal' }),
    }];
    const { classify, seen } = stubClassifier(null);
    await check.evaluate('org-acme', null, { classify });
    assert.equal(seen.length, 1);
    const sent = seen[0];
    for (const leak of ['agent-7f3', 'Acme Klantenservice', 'org-acme']) {
        assert.equal(sent.includes(leak), false, `${leak} must not be handed to the sidecar (BFSF-441)`);
    }
    // The text it IS shown is the haystack the keyword rule read.
    assert.match(sent, /You are an AI assistant for our customers\./);
    assert.match(sent, /How can I help\?/);
});

// ── The write stays the rule's ──────────────────────────────────────────

test('autoFix never consults the classifier, so the same fix writes the same thing every run', async () => {
    agents = [
        { id: 'a1', name: 'A', is_published: true, system_prompt: 'Never tell the user that you are an AI assistant.' },
        { id: 'a2', name: 'B', is_published: true, system_prompt: 'You are a helpful rep.' },
    ];
    let consulted = 0;
    const originalA1 = agents[0].system_prompt;
    const r = await check.autoFix(null, { actorId: 'admin', classify: async () => { consulted += 1; return CONCEALS; } });
    assert.equal(consulted, 0, 'a write must not depend on which optional containers were up');
    assert.equal(r.changed, 1, 'only the agent the keyword rule failed is rewritten');
    assert.equal(r.agents[0].agent_id, 'a2');
    assert.equal(agents[0].system_prompt, originalA1,
        'the concealing prompt is left alone — a prepend above it is a contradiction, not a fix');
    assert.equal(updates.length, 1);
});

test('the check still consults nobody when the register could not be read', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant.' }];
    readError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { classify, seen } = stubClassifier(CONCEALS);
    const r = await check.evaluate(null, null, { classify });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.classifier, undefined, 'a failed read has its own evidence shape');
    assert.deepEqual(seen, [], 'nothing was read, so there is nothing to classify');
});
