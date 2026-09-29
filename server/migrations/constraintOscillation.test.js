/**
 * No constraint may be ADDED by a migration that runs before one that DROPS it.
 *
 * stores/automationStore/core.js replays its whole MIGRATIONS array on EVERY
 * process start — there is no versioned ledger, no "already applied" table.
 * That makes the array's ORDER a live, per-boot program, not a history.
 *
 * So an earlier migration that adds constraint C and a later one that drops C
 * do not "settle": every boot re-adds and re-drops it. When the add is guarded
 * by "delete the rows that would violate it first" — which is how you make an
 * ADD CONSTRAINT succeed on dirty data — that oscillation becomes a silent
 * bulk DELETE once per boot, forever.
 *
 * That is not hypothetical. automation-fk-cascade-2026-06 added
 * fk_approval_audit_run (deleting orphans first) and automation-approvals-2026-08
 * drops it, precisely so approval audit rows can outlive the runs that
 * jobs/runRetention.js deletes at 90 days. Together they deleted the audit
 * trail on every restart, and the FIRST boot always looked clean because the
 * constraint was still there from the previous image.
 *
 * Reads the migrations as SOURCE: the thing under test is the relationship
 * between two files' statements, not any callable. Run:
 *   node --test --test-force-exit migrations/constraintOscillation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CORE = path.join(HERE, '..', 'stores', 'automationStore', 'core.js');

/** The MIGRATIONS array, in replay order, read out of core.js as source. */
function migrationOrder() {
    const src = fs.readFileSync(CORE, 'utf8');
    const open = src.indexOf('const MIGRATIONS = [');
    assert.ok(open > -1, 'core.js no longer declares MIGRATIONS — this test has gone stale');
    const close = src.indexOf('];', open);
    return [...src.slice(open, close).matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
}

/** constraint names a migration ADDs, and ones it DROPs. */
function constraintsIn(name) {
    const file = path.join(HERE, `${name}.js`);
    if (!fs.existsSync(file)) return { adds: new Set(), drops: new Set() };
    const src = fs.readFileSync(file, 'utf8');
    const adds = new Set();
    const drops = new Set();
    // Literal form: ADD CONSTRAINT fk_foo
    for (const m of src.matchAll(/ADD\s+CONSTRAINT\s+([a-z0-9_]+)/gi)) adds.add(m[1]);
    for (const m of src.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/gi)) drops.add(m[1]);
    // Templated form: ADD CONSTRAINT ${constraint} — recover the names from the
    // call sites that supply them, so a helper-driven migration is not invisible.
    if (/ADD\s+CONSTRAINT\s+\$\{/i.test(src)) {
        for (const m of src.matchAll(/constraint:\s*'([a-z0-9_]+)'/gi)) adds.add(m[1]);
    }
    return { adds, drops };
}

test('the scan finds migrations and constraints at all', () => {
    const order = migrationOrder();
    assert.ok(order.length > 20, `only ${order.length} migrations parsed — the scan has gone stale`);
    const totalAdds = order.reduce((n, m) => n + constraintsIn(m).adds.size, 0);
    assert.ok(totalAdds > 0, 'no ADD CONSTRAINT found anywhere — the scan has gone stale');
});

test('no migration adds a constraint that a later migration drops', () => {
    const order = migrationOrder();
    const parsed = order.map(name => ({ name, ...constraintsIn(name) }));

    const oscillating = [];
    for (let i = 0; i < parsed.length; i++) {
        for (const added of parsed[i].adds) {
            for (let j = i + 1; j < parsed.length; j++) {
                if (parsed[j].drops.has(added)) {
                    oscillating.push(
                        `${added}: added by ${parsed[i].name} (#${i}), dropped by ${parsed[j].name} (#${j}) ` +
                        '— both replay every boot, so this cycles forever',
                    );
                }
            }
        }
    }

    assert.deepEqual(oscillating, [],
        'a constraint added before it is dropped oscillates once per process start:\n  ' +
        oscillating.join('\n  '));
});

test('fk_approval_audit_run specifically stays dropped', () => {
    // The regression that motivated this file. Named explicitly so that
    // re-adding it fails with the reason rather than as a generic violation.
    const order = migrationOrder();
    const adders = order.filter(m => constraintsIn(m).adds.has('fk_approval_audit_run'));
    assert.deepEqual(adders, [],
        'automation_approval_audit is the append-only approval event log: its rows must ' +
        'outlive the runs jobs/runRetention.js deletes at 90 days. An FK to automation_runs ' +
        `re-adds the cascade that automation-approvals-2026-08 exists to remove (added by: ${adders.join(', ')}).`);
});
