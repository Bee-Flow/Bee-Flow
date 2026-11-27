/**
 * The usage scans, against a REAL Postgres (@electric-sql/pglite, in-process).
 *
 * ── WHY THIS EXISTS ALONGSIDE kbUsage.test.js ───────────────────────
 * The sibling suite proves the POLICY: a missing table is partial and never
 * zero, one failing scan does not abandon the rest, the id goes into jsonpath
 * as a variable. It cannot prove the queries are right, because its fake
 * `query()` never parses the SQL — so a scan naming a column that does not
 * exist passes there and returns nothing in production.
 *
 * That is not a hypothetical. Written from the store headers alone, five of
 * the eight scans named a column the table has not got: `agents.user_id` and
 * `projects.user_id` (both are `owner_id`), `automations.name` (it is
 * `title`), `notebooks.title` (it is `name`), and
 * `support_inboxes.support_ai_kb_ids` — which is a configStore KEY, while the
 * column is `kb_ids`. Every one of them would have made the delete dialog say
 * "nothing depends on this" about a base three agents were using, and the
 * person would have believed it, because they asked.
 *
 * So this creates the tables as production has them, seeds one consumer of
 * each kind, and asserts the scan FINDS it. A column rename that breaks a
 * scan fails here loudly instead of going quiet.
 *
 * The tables and the seed are ./kbUsage.pg.testkit.js. What a module's part finds and
 * scrubs is proved beside it (usage/<module>.pg.test.js).
 *
 * Run: cd server && node --test --test-force-exit core/kb/kbUsage.pg.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePgKbUsage, KB, OTHER } = require('./kbUsage.pg.testkit');
const { db, q } = usePgKbUsage(test);

const { usageForKb, usageSummary, scrubReferences, KINDS } = require('./kbUsage');

// About the composition: these hold for every kind of this installation.
test('every scan finds its consumer — no scan is quietly matching nothing', async () => {
    const { rows, partial } = await usageForKb(KB, { db });
    assert.deepStrictEqual(partial, [], 'all eight tables exist here');

    const found = new Set(rows.map(r => r.kind));
    for (const kind of KINDS) {
        assert.ok(found.has(kind), `the ${kind} scan found nothing — check its column names`);
    }
});

test('the rows carry the Used-by shape, filled in from the real columns', async () => {
    const { rows } = await usageForKb(KB, { db });
    const agent = rows.find(r => r.kind === 'agent');
    assert.deepStrictEqual(
        { kind: agent.kind, id: agent.id, title: agent.title, role: agent.role, ownerId: agent.ownerId },
        { kind: 'agent', id: 'ag1', title: 'Support assistant', role: 'chat', ownerId: 'u1' },
    );
    assert.ok(agent.lastAt, 'updated_at came through as lastAt');

    // The one that a `name AS title` / `title` mix-up would have blanked (the automation's: usage/automation.pg.test.js).
    assert.strictEqual(rows.find(r => r.kind === 'notebook').title, 'Research');
    // The two whose owner column is owner_id, not user_id.
    assert.strictEqual(rows.find(r => r.kind === 'project').ownerId, 'u1');
    assert.strictEqual(agent.ownerId, 'u1');
});

test('a consumer of a DIFFERENT base is not reported', async () => {
    const { rows } = await usageForKb(KB, { db });
    const ids = rows.map(r => r.id);
    assert.ok(!ids.includes('ag2'));
    assert.ok(!ids.includes('au2'));
    assert.ok(!ids.includes('wp2'));
});

test('an id carrying a quote is bound, not parsed as jsonpath', async () => {
    // The injection this shape exists to prevent: concatenated, the quote
    // would close the string literal inside the path.
    await assert.doesNotReject(() => usageForKb('kb" ? (@ == "x', { db }));
    const { rows } = await usageForKb('kb" ? (@ == "x', { db });
    assert.deepStrictEqual(rows, [], 'and it matches nothing, rather than everything');
});

test('the summary counts the same consumers the detail scan finds', async () => {
    const out = await usageSummary([KB, OTHER], { db });
    for (const kind of KINDS) {
        assert.ok(out[KB].counts[kind] >= 1, `summary missed ${kind}`);
    }
    assert.deepStrictEqual(out[KB].partial, []);
    assert.deepStrictEqual(out[OTHER].counts, Object.fromEntries(Object.entries({ agent: 1, automation: 1, webpage: 1 }).filter(([kind]) => KINDS.includes(kind))));
});

test('scrub removes the id from every array, and leaves the others intact', async () => {
    const before = await usageForKb(KB, { db });
    assert.ok(before.rows.length >= KINDS.length);

    const out = await scrubReferences(KB, { db });
    assert.strictEqual(out.agent, 1);
    assert.strictEqual(out.project, 1);

    const after_ = await usageForKb(KB, { db });
    const kinds = new Set(after_.rows.map(r => r.kind));
    assert.ok(!kinds.has('agent'), 'the agent no longer names it');
    assert.ok(!kinds.has('project'));
    assert.ok(!kinds.has('notebook'));

    // And the other base's consumers were not collateral.
    const other = await usageForKb(OTHER, { db });
    assert.ok(other.rows.some(r => r.id === 'ag2'));

    // The agent keeps its config; only the id left.
    const cfg = (await q(`SELECT config FROM agents WHERE id = 'ag1'`)).rows[0].config;
    assert.deepStrictEqual(JSON.parse(cfg).knowledge_base_ids, []);
});

