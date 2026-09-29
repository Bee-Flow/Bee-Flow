/**
 * Retention on an audit trail deletes evidence, so every test here is about
 * NOT deleting: the default, the unreadable setting, the too-short window, and
 * the wrong time column.
 *
 * The asymmetry is the whole point. A window that turns out longer than
 * intended keeps rows nobody needed — a minimisation problem, fixable
 * tomorrow. A window that turns out shorter, or that fires when it should not,
 * destroys the access-control history an auditor asks for, and nothing brings
 * it back. So every unknown resolves towards keeping.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub, evictModule } = require('../testUtils/stubRequire');

/** Load the module with a given env, isolated from the previous load. */
function loadWith(env) {
    const file = require.resolve('./monitoringRetention.js');
    const saved = { ...process.env };
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
        for (const k of ['ACCESS_AUDIT_RETENTION_DAYS', 'MONITORING_LOG_RETENTION_DAYS']) delete process.env[k];
        Object.assign(process.env, env);
        delete require.cache[file];
        // The module pulls in ../db at require time; the pool is never used
        // because no pass is run here.
        return { mod: require('./monitoringRetention.js'), warnings };
    } finally {
        console.warn = realWarn;
        process.env = saved;
        delete require.cache[file];
    }
}

test('the default is OFF — an upgrade never starts purging evidence', () => {
    // The single most important line in this file. Somebody installing a new
    // version must not silently lose access-control history they still have.
    const { mod } = loadWith({});
    assert.strictEqual(mod.ACCESS_AUDIT_RETENTION_DAYS, 0);
});

test('an unreadable setting keeps everything rather than deleting everything', () => {
    // '90 days', a template that did not substitute, a stray quote. Each must
    // land on "keep", never on 0-meaning-purge-now or NaN.
    for (const bad of ['ninety', '90 days', '${DAYS}', 'null', 'NaN']) {
        const { mod, warnings } = loadWith({ ACCESS_AUDIT_RETENTION_DAYS: bad });
        assert.strictEqual(mod.ACCESS_AUDIT_RETENTION_DAYS, 0, `${JSON.stringify(bad)} did not resolve to off`);
        assert.ok(warnings.some((w) => /ACCESS_AUDIT_RETENTION_DAYS/.test(w)), `${JSON.stringify(bad)} was swallowed`);
    }
});

test('a window shorter than the certification cycle is raised, loudly', () => {
    // An auditor asks for the cycle, not the last quarter. A 30-day window set
    // in good faith would quietly destroy most of what they ask to see.
    const { mod, warnings } = loadWith({ ACCESS_AUDIT_RETENTION_DAYS: '30' });
    assert.strictEqual(mod.ACCESS_AUDIT_RETENTION_DAYS, mod.MIN_ACCESS_AUDIT_DAYS);
    assert.ok(warnings.some((w) => /raised to/.test(w)));
});

test('a deliberate long window is honoured exactly', () => {
    const { mod } = loadWith({ ACCESS_AUDIT_RETENTION_DAYS: '1095' });
    assert.strictEqual(mod.ACCESS_AUDIT_RETENTION_DAYS, 1095);
});

test('an explicit 0 or negative is off, not an error and not a purge', () => {
    for (const off of ['0', '-1']) {
        const { mod } = loadWith({ ACCESS_AUDIT_RETENTION_DAYS: off });
        assert.strictEqual(mod.ACCESS_AUDIT_RETENTION_DAYS, 0);
    }
});

/**
 * Load the module with a given env AND a fake ../db that records every
 * DELETE the pass issues (table, WHERE column, cutoff param) instead of
 * touching a real pool. The advisory lock always "acquires".
 */
function loadWithFakeDb(env) {
    const calls = [];
    // Node's own require cache has a "same directory" fast path keyed on
    // (parent dir, request string) that answers straight from
    // Module._cache, bypassing _resolveFilename entirely — so once an
    // earlier test above required this module with the REAL ../db, a later
    // stub on '../db' would be skipped unless that real module is evicted
    // first, forcing the next require through resolution (and the stub) again.
    evictModule(require.resolve('../db'));
    const restoreDb = installResolveStub({
        '../db': {
            pool: {
                connect: async () => ({
                    query: async (sql) => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ locked: true }] } : {}),
                    release: () => {},
                }),
            },
            run: async (sql, params) => {
                const m = /DELETE FROM (\w+)[\s\S]*WHERE (\w+) </.exec(sql);
                calls.push({ table: m && m[1], timeCol: m && m[2], cutoff: params[0] });
                return { rowCount: 0 }; // one batch is enough; _deleteBatches stops itself
            },
        },
    });
    const { mod, warnings } = loadWith(env);
    return { mod, warnings, calls, restore: restoreDb };
}

test('the audit pass reads created_at, the monitoring pass reads timestamp — each on its OWN cutoff', async () => {
    // access_audit_log has no `timestamp` column: deleting on the wrong
    // column is not a no-op in Postgres, it is an error that would abort the
    // whole pass and silently stop the monitoring ledgers being reaped too.
    // Reusing the monitoring cutoff for the audit trail would apply the
    // wrong window without either failing loudly — so the two windows are
    // set to different lengths here, not just different on/off states.
    const { mod, calls, restore } = loadWithFakeDb({ MONITORING_LOG_RETENTION_DAYS: '400', ACCESS_AUDIT_RETENTION_DAYS: '1095' });
    try {
        await mod.monitoringRetentionPass();
        const byTable = Object.fromEntries(calls.map((c) => [c.table, c]));
        assert.strictEqual(byTable.integration_activity_log?.timeCol, 'timestamp');
        assert.strictEqual(byTable.guardrail_events?.timeCol, 'timestamp');
        assert.strictEqual(byTable.access_audit_log?.timeCol, 'created_at');
        assert.notStrictEqual(
            byTable.access_audit_log.cutoff, byTable.integration_activity_log.cutoff,
            'a 1095-day audit window and a 400-day monitoring window must not share one cutoff',
        );
    } finally {
        restore();
    }
});

test('each window gates only its own deletes', async () => {
    // The trap: one `if (!RETENTION_DAYS) return` at the top would mean
    // turning monitoring retention off also turns the audit window off,
    // silently.
    {
        const { mod, calls, restore } = loadWithFakeDb({ MONITORING_LOG_RETENTION_DAYS: '0', ACCESS_AUDIT_RETENTION_DAYS: '400' });
        try {
            await mod.monitoringRetentionPass();
            assert.deepStrictEqual(calls.map((c) => c.table), ['access_audit_log'],
                'monitoring off must not also turn the audit window off');
        } finally {
            restore();
        }
    }
    {
        const { mod, calls, restore } = loadWithFakeDb({ MONITORING_LOG_RETENTION_DAYS: '400' }); // ACCESS_AUDIT_RETENTION_DAYS defaults off
        try {
            await mod.monitoringRetentionPass();
            assert.deepStrictEqual(calls.map((c) => c.table).sort(), ['guardrail_events', 'integration_activity_log'],
                'the audit window defaulting to off must not also turn monitoring retention off');
        } finally {
            restore();
        }
    }
});

test('the two windows are independent', () => {
    // Turning the monitoring ledgers off must not switch the audit trail on, or
    // the other way round — they answer to different obligations.
    const { mod: a } = loadWith({ MONITORING_LOG_RETENTION_DAYS: '0', ACCESS_AUDIT_RETENTION_DAYS: '400' });
    assert.strictEqual(a.RETENTION_DAYS, 0);
    assert.strictEqual(a.ACCESS_AUDIT_RETENTION_DAYS, 400);

    const { mod: b } = loadWith({ MONITORING_LOG_RETENTION_DAYS: '400' });
    assert.strictEqual(b.RETENTION_DAYS, 400);
    assert.strictEqual(b.ACCESS_AUDIT_RETENTION_DAYS, 0);
});

// 'the audit pass reads created_at, and the monitoring pass reads timestamp',
// 'each window gates only its own deletes' and 'the audit cutoff is computed
// from its own window' used to live here as source-text scans of
// monitoringRetention.js. Replaced above by 'the audit pass reads
// created_at, the monitoring pass reads timestamp — each on its OWN cutoff'
// and 'each window gates only its own deletes', which drive the real
// monitoringRetentionPass() against a fake ../db and read what it actually
// deleted, rather than what the source says it deletes.
