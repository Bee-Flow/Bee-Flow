/**
 * The compose normaliser is the trust boundary between a language model and
 * the scheduler, so these tests are mostly about what it REFUSES.
 *
 * The agent rule is the sharp one. Linking an agent is not cosmetic: the run
 * goes through that agent's system prompt, skills, knowledge bases and
 * connected apps. A model that assigns the user's Invoice agent to a
 * "good morning" greeting would quietly route every future greeting through
 * it. So an agent is only accepted when the brief actually points at it.
 *
 * Run: node --test core/coworkCompose.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { normaliseSpec, fallbackSpec, buildComposePrompt } = require('./coworkCompose');

const AGENTS = [
    { id: 'a-bugs', name: 'Bugs & Feedback Agent', description: 'Triages bugs' },
    { id: 'a-inv', name: 'Invoice Generator', description: 'Makes invoices' },
];

const GREETING = 'Ik wil dat je elke ochtend een goede morgen wenst, en zorg dat ik positief begin';

// ── Agent selection: only on a clear instruction ────────────────────

test('an agent named in the brief is accepted', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-bugs', agentQuote: 'Bugs & Feedback Agent' },
        { brief: 'laat de Bugs & Feedback Agent elke maandag de bugs samenvatten', agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, 'a-bugs');
    assert.match(spec.agentReason, /Bugs & Feedback Agent/);
});

test('an agent nobody asked for is dropped', () => {
    // The classic failure: topical similarity read as an instruction.
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-inv', agentQuote: null },
        { brief: 'vat elke maand mijn facturen samen', agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, null, 'topic overlap is not an instruction');
    assert.strictEqual(spec.agentReason, null);
});

test('a fabricated quote does not buy an agent', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-inv', agentQuote: 'use the Invoice Generator' },
        { brief: GREETING, agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, null, 'the quote must occur in the brief');
});

test('a genuine quote that is not the agent name still qualifies', () => {
    const brief = 'laat mijn factuurbot dit elke maand doen';
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-inv', agentQuote: 'mijn factuurbot' },
        { brief, agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, 'a-inv');
    assert.match(spec.agentReason, /factuurbot/);
});

test('an agent id the user does not own is dropped', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-someone-else', agentQuote: 'Bugs & Feedback Agent' },
        { brief: 'laat de Bugs & Feedback Agent het doen', agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, null);
});

test('agent matching ignores case and spacing', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-bugs', agentQuote: null },
        { brief: 'laat de   bugs & FEEDBACK agent   dit doen', agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, 'a-bugs');
});

test('a one-character quote cannot match its way in', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', agentId: 'a-inv', agentQuote: 'e' },
        { brief: GREETING, agents: AGENTS },
    );
    assert.strictEqual(spec.agentId, null);
});

// ── Schedule fields are whitelisted, not parsed ─────────────────────

test('a valid repeat and time survive', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', repeatInterval: 'daily', timeOfDay: '08:00' },
        { brief: GREETING, agents: [] },
    );
    assert.strictEqual(spec.repeatInterval, 'daily');
    assert.strictEqual(spec.timeOfDay, '08:00');
    assert.strictEqual(spec.runOnce, false);
});

test('an invented interval is discarded, leaving a one-off', () => {
    const spec = normaliseSpec(
        { title: 'T', prompt: 'P', repeatInterval: 'every morning' },
        { brief: GREETING, agents: [] },
    );
    assert.strictEqual(spec.repeatInterval, null);
    assert.strictEqual(spec.runOnce, true);
});

test('a malformed time is discarded rather than half-parsed', () => {
    for (const bad of ['8:00', '25:00', '08:60', 'morning', '08.00', '']) {
        const spec = normaliseSpec({ timeOfDay: bad }, { brief: GREETING, agents: [] });
        assert.strictEqual(spec.timeOfDay, null, `${bad} should be rejected`);
    }
});

test('weekday tokens are filtered and put in calendar order', () => {
    const spec = normaliseSpec(
        { daysOfWeek: ['FRIDAY', 'mon', 'nope', 'wed', 'mon'] },
        { brief: GREETING, agents: [] },
    );
    assert.deepStrictEqual(spec.daysOfWeek, ['mon', 'wed', 'fri']);
});

test('an empty or non-array day list becomes null', () => {
    assert.strictEqual(normaliseSpec({ daysOfWeek: [] }, { brief: 'x' }).daysOfWeek, null);
    assert.strictEqual(normaliseSpec({ daysOfWeek: 'mon' }, { brief: 'x' }).daysOfWeek, null);
    assert.strictEqual(normaliseSpec({ daysOfWeek: ['xxx'] }, { brief: 'x' }).daysOfWeek, null);
});

test('named days alone make it a repeat, whatever runOnce claimed', () => {
    const spec = normaliseSpec(
        { daysOfWeek: ['mon'], repeatInterval: null, runOnce: true },
        { brief: 'elke maandag', agents: [] },
    );
    assert.strictEqual(spec.runOnce, false, 'a day list is a schedule');
});

test('runOnce is not taken at its word when no schedule was given', () => {
    const spec = normaliseSpec(
        { repeatInterval: null, daysOfWeek: null, runOnce: false },
        { brief: GREETING, agents: [] },
    );
    assert.strictEqual(spec.runOnce, true, 'no interval and no days is a one-off');
});

// ── Title and prompt fall back to the user, never to invention ──────

test('a missing title falls back to the user\'s own opening clause', () => {
    const spec = normaliseSpec({ prompt: 'P' }, { brief: GREETING, agents: [] });
    assert.ok(spec.title.length > 0);
    assert.ok(GREETING.toLowerCase().startsWith(spec.title.replace(/…$/, '').toLowerCase().slice(0, 20)));
});

test('a missing prompt falls back to the brief verbatim', () => {
    const spec = normaliseSpec({ title: 'T' }, { brief: GREETING, agents: [] });
    assert.strictEqual(spec.prompt, GREETING);
});

test('titles are capped and surrounding quotes stripped', () => {
    const spec = normaliseSpec({ title: `"${'x'.repeat(200)}"`, prompt: 'P' }, { brief: 'b', agents: [] });
    assert.ok(spec.title.length <= 60, `title was ${spec.title.length}`);
    assert.ok(!spec.title.startsWith('"'));
});

test('a null model reply degrades to the brief as a one-off', () => {
    const spec = fallbackSpec(GREETING);
    assert.strictEqual(spec.prompt, GREETING);
    assert.strictEqual(spec.repeatInterval, null);
    assert.strictEqual(spec.agentId, null);
    assert.ok(spec.title.length > 0);
});

test('a blank brief still produces a usable shape', () => {
    const spec = fallbackSpec('');
    assert.strictEqual(typeof spec.title, 'string');
    assert.strictEqual(typeof spec.prompt, 'string');
});

// ── The prompt tells the model the rule ─────────────────────────────

test('the compose prompt states the agent restraint and lists the agents', () => {
    const prompt = buildComposePrompt({ agents: AGENTS, timezone: 'Europe/Amsterdam', nowLabel: 'now' });
    assert.match(prompt, /Default to null/);
    assert.match(prompt, /is NOT enough/);
    assert.match(prompt, /a-bugs/);
    assert.match(prompt, /Bugs & Feedback Agent/);
});

test('the compose prompt copes with a user who has no agents', () => {
    const prompt = buildComposePrompt({ agents: [], timezone: 'UTC', nowLabel: 'now' });
    assert.match(prompt, /no agents/);
});
