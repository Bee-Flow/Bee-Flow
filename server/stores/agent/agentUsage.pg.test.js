'use strict';

/**
 * The agent usage scans, against a REAL Postgres (@electric-sql/pglite,
 * in-process).
 *
 * ── WHY THIS EXISTS ALONGSIDE agentUsage.test.js ────────────────────
 * The sibling suite proves the POLICY: a missing table is partial and never
 * zero, one failing scan does not abandon the rest, no id enters a jsonpath.
 * It cannot prove the queries are RIGHT, because its fake `query()` never
 * parses SQL — so a scan naming a column the table has not got passes there
 * and finds nothing in production, which is the same wound the knowledge-base
 * scans took (five of eight named a column that did not exist).
 *
 * So this creates the consumer tables as their stores declare them, seeds one
 * consumer of every kind, and asserts the scan FINDS it. A column rename that
 * breaks a scan fails here loudly instead of going quiet.
 *
 * ── THE FORWARD-LOOKING SHAPES ARE PINNED HERE ──────────────────────
 * `ai_step.agentId` (R2), the app AI block (P) and the webpage bridge grant
 * (W3) do not exist yet. The shapes this suite seeds are the contract: a
 * consumer that records an agent under the key `agentId` at ANY depth is
 * found, and so is a bare string at `bridge_grants.agent`. Whoever builds
 * those features can read this file to see what the delete guard will notice.
 *
 * The consumer tables and the seed are ./agentUsage.testkit.js (usePgUsage). Every kind is a
 * module's part: what one part finds is proved beside it (usage/<module>.pg.test.js); the
 * tests here hold over every kind, for the kinds of this installation.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentUsage.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { usePgUsage, AGENT, OTHER } = require('./agentUsage.testkit');
const { db } = usePgUsage(test);

const { usageForAgent, usageCountsForAgents, KINDS } = require('./agentUsage');

// About the composition: these hold for every kind of this installation.
test('every scan finds its consumer — no scan is quietly matching nothing', async () => {
    const { rows, partial } = await usageForAgent(AGENT, { db });
    assert.deepStrictEqual(partial, [], 'all six tables exist here');
    const found = new Set(rows.map(r => r.kind));
    for (const kind of KINDS) {
        assert.ok(found.has(kind), `the ${kind} scan found nothing — check its columns`);
    }
});

test('an agent nothing uses comes back empty — and that emptiness was really checked', async () => {
    const { rows, partial } = await usageForAgent('agent-nobody-uses', { db });
    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(partial, []);
});

test('the other agent gets only its own consumers', async () => {
    const { rows } = await usageForAgent(OTHER, { db });
    assert.deepStrictEqual(rows.map(r => `${r.kind}:${r.id}`).sort(), ['automation:au-2', 'task:task-2'].filter(r => KINDS.includes(r.split(':')[0])));
});

test('an id carrying jsonpath syntax is data, not syntax', async () => {
    await assert.doesNotReject(() => usageForAgent('ag" ? (@ == "x', { db }));
    const { rows, partial } = await usageForAgent('ag" ? (@ == "x', { db });
    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(partial, []);
});

test('the batch counter agrees with the per-agent scan, over both agents at once', async () => {
    const out = await usageCountsForAgents([AGENT, OTHER, 'agent-nobody-uses'], { db });
    const here = (counts) => Object.fromEntries(Object.entries(counts).filter(([kind]) => KINDS.includes(kind)));
    assert.deepStrictEqual(out[AGENT].counts, here({
        task: 1, cowork: 1, support: 1, automation: 1, app: 1, webpage: 3,
    }));
    assert.deepStrictEqual(out[OTHER].counts, here({ task: 1, automation: 1 }));
    assert.deepStrictEqual(out['agent-nobody-uses'].counts, {});
    assert.deepStrictEqual(out[AGENT].partial, []);
});

