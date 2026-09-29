/**
 * Smoke scenarios — ISO 27001 governance registers:
 * A.5.24 incident management, A.5.9 asset inventory, A.5.20 supplier
 * agreements and A.5.28 evidence chain integrity.
 */

const { t, assertStatus, resetState, _state } = require('./harness');
const incidentStore = require('../../../stores/incidentStore');

module.exports = async function isoGovernance() {
    // ONE extra store stub the base harness lacks (evidence enrichment only —
    // status never depends on it). Stores are singletons, so assigning here,
    // after the base stubs, is sufficient:
    incidentStore.listNeedingAttention = async () => _state.incidentAttention || [];

    const isoChecks = {
        incidentMgmt: require('../../checks/iso27001/a5-24-incident-mgmt'),
        assetInventory: require('../../checks/iso27001/a5-9-asset-inventory'),
        suppliers: require('../../checks/iso27001/a5-20-suppliers'),
        evidenceIntegrity: require('../../checks/iso27001/a5-28-evidence-integrity'),
    };

    log.info('\n▶ ISO 27001 A.5.24 — Incident management');
    await t('pass with recipient and clean register', async () => {
        resetState();
        _state.incidentAttention = [];
        _state.settings.breach_recipients = ['ciso@example.com'];
        assertStatus(await isoChecks.incidentMgmt.evaluate('x'), 'pass', 'ready');
    });
    await t('fail when an incident is past its deadline unnotified', async () => {
        resetState();
        _state.settings.breach_recipients = ['ciso@example.com'];
        _state.incidentDeadlines = { open: 1, overdue_unnotified: 1, nearing_deadline: 0 };
        _state.incidentAttention = [{ id: 7, severity: 'high', status: 'open', deadline_at: new Date(Date.now() - 3600 * 1000).toISOString() }];
        assertStatus(await isoChecks.incidentMgmt.evaluate('x'), 'fail', 'overdue');
    });
    await t('warn when no notification recipients are configured', async () => {
        resetState();
        _state.incidentAttention = [];
        assertStatus(await isoChecks.incidentMgmt.evaluate('x'), 'warn', 'no recipients');
    });
    await t('warn when an incident nears its deadline', async () => {
        resetState();
        _state.settings.breach_recipients = ['ciso@example.com'];
        _state.incidentDeadlines = { open: 1, overdue_unnotified: 0, nearing_deadline: 1 };
        _state.incidentAttention = [{ id: 8, severity: 'medium', status: 'assessing', deadline_at: new Date(Date.now() + 3600 * 1000).toISOString() }];
        assertStatus(await isoChecks.incidentMgmt.evaluate('x'), 'warn', 'nearing');
    });
    await t('pass with open incidents still inside the window', async () => {
        resetState();
        _state.incidentAttention = [];
        _state.settings.breach_recipients = ['ciso@example.com'];
        _state.incidentDeadlines = { open: 2, overdue_unnotified: 0, nearing_deadline: 0 };
        assertStatus(await isoChecks.incidentMgmt.evaluate('x'), 'pass', 'inside window');
    });

    log.info('\n▶ ISO 27001 A.5.9 — Asset inventory');
    await t('not_applicable when nothing is configured', async () => {
        resetState();
        assertStatus(await isoChecks.assetInventory.evaluate('x'), 'not_applicable', 'empty workspace');
    });
    await t('pass when assets are enumerable across classes', async () => {
        resetState();
        _state.config['ai'] = { providers: [{ id: 'p1', type: 'ollama' }, { id: 'p2', type: 'openai' }] };
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'ollama/llama3', organization_id: 'x' }],
        }];
        _state.dbOne = [
            { query: /knowledge_bases/, row: { c: 3 } },
            { query: /integration_connections/, row: { c: 2 } },
            { query: /mcp_servers/, row: { c: 1 } },
        ];
        assertStatus(await isoChecks.assetInventory.evaluate('x'), 'pass', 'full inventory');
    });
    await t('warn when agents run without any registered provider', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'openai/gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await isoChecks.assetInventory.evaluate('x'), 'warn', 'inventory incomplete');
    });
    await t('pass with providers only (edge: single asset class)', async () => {
        resetState();
        _state.config['ai'] = { providers: [{ id: 'p1', type: 'openai' }] };
        assertStatus(await isoChecks.assetInventory.evaluate('x'), 'pass', 'providers only');
    });

    log.info('\n▶ ISO 27001 A.5.20 — Supplier agreements');
    await t('not_applicable without observed traffic', async () => {
        resetState();
        assertStatus(await isoChecks.suppliers.evaluate('x'), 'not_applicable', 'no traffic');
    });
    await t('warn when an observed supplier lacks an attestation', async () => {
        resetState();
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', is_eu: false, calls: 15 }],
        }];
        assertStatus(await isoChecks.suppliers.evaluate('x'), 'warn', 'uncovered supplier');
    });
    await t('pass when every observed supplier is attested', async () => {
        resetState();
        _state.settings.scc_confirmed_operators = [{ operator: 'openai' }];
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', is_eu: false, calls: 15 }],
        }];
        assertStatus(await isoChecks.suppliers.evaluate('x'), 'pass', 'all attested');
    });
    await t('warn for an unattested EU supplier too (edge: EU is not exempt)', async () => {
        resetState();
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'scaleway', is_eu: true, calls: 40 }],
        }];
        assertStatus(await isoChecks.suppliers.evaluate('x'), 'warn', 'EU uncovered');
    });

    // A.5.28 is verified through compliance/evidence/chain.verifyChain, which
    // reads compliance_evidence itself: an aggregate row (getOne) plus the
    // newest linked rows (getAll). These scenarios therefore build a REAL
    // chain — `hash = sha256(prev_hash ∥ payload_hash)` over the canonical
    // payload — instead of the pre-rewrite {total, valid_hashes} shape, which
    // the check stopped reading and which left this suite red.
    const { linkHash } = require('../../evidence/chain');
    const { hashPayload } = require('../../evidence/canonical');

    /** Build a valid chain of `n` linked rows, newest last (seq 1..n). */
    function chainRows(n) {
        const rows = [];
        let prev = null;
        for (let i = 1; i <= n; i++) {
            const payload = { status: 'pass', evidence: { ok: true }, details: `row ${i}`, run_type: 'scheduled', subject: null };
            const payload_hash = hashPayload(payload);
            const hash = linkHash(prev, payload_hash);
            rows.push({ seq: i, hash, prev_hash: prev, payload_hash, payload });
            prev = hash;
        }
        return rows;
    }
    /** The aggregate row verifyChain's first query returns. */
    function aggregate(rows, { latest = new Date(Date.now() - 3600 * 1000).toISOString(), preChain = 0, preChainInvalid = 0 } = {}) {
        return {
            rows_total: rows.length + preChain,
            chained_rows: rows.length,
            pre_chain_rows: preChain,
            pre_chain_invalid: preChainInvalid,
            latest_captured_at: latest,
        };
    }
    function stubChain(rows, aggOpts) {
        _state.dbOne = [{ query: /FROM compliance_evidence/, row: aggregate(rows, aggOpts) }];
        _state.dbRows = [{ query: /FROM compliance_evidence/, rows }];
    }

    log.info('\n▶ ISO 27001 A.5.28 — Evidence chain integrity');
    await t('warn when the chain has no recent rows', async () => {
        resetState();
        assertStatus(await isoChecks.evidenceIntegrity.evaluate('x'), 'warn', 'empty chain');
    });
    await t('fail when recent rows carry invalid hashes', async () => {
        resetState();
        const rows = chainRows(3);
        rows[1].hash = 'b'.repeat(64); // a link that no longer hashes to its inputs
        stubChain(rows);
        const r = await isoChecks.evidenceIntegrity.evaluate('x');
        assertStatus(r, 'fail', 'invalid hashes');
        if (r.evidence.first_break?.reason !== 'link' || r.evidence.first_break?.seq !== 2) {
            throw new Error(`expected a link break at seq 2, got ${JSON.stringify(r.evidence.first_break)}`);
        }
    });
    await t('pass with a valid, fresh chain whose payloads still match their fingerprints', async () => {
        resetState();
        const rows = chainRows(3);
        stubChain(rows);
        const r = await isoChecks.evidenceIntegrity.evaluate('x');
        assertStatus(r, 'pass', 'valid chain');
        if (r.evidence.verified_rows !== 3 || r.evidence.first_break !== null || r.evidence.head?.seq !== 3) {
            throw new Error(`expected 3 verified rows and no break, got ${JSON.stringify({ verified: r.evidence.verified_rows, brk: r.evidence.first_break, head: r.evidence.head })}`);
        }
    });
    await t('fail when a payload was altered in place with the links left intact (content break)', async () => {
        // Was "pass even when the sample recompute mismatches": the payload
        // fingerprint is now computed over the CANONICAL form, which survives
        // the JSONB round-trip, so a recompute mismatch is no longer a false
        // alarm to tolerate — it is evidence tampering and must gate.
        resetState();
        const rows = chainRows(3);
        rows[2].payload = { ...rows[2].payload, details: 'rewritten after the fact' };
        stubChain(rows);
        const r = await isoChecks.evidenceIntegrity.evaluate('x');
        assertStatus(r, 'fail', 'content break gates');
        if (r.evidence.first_break?.reason !== 'content' || r.evidence.first_break?.seq !== 3) {
            throw new Error(`expected a content break at seq 3, got ${JSON.stringify(r.evidence.first_break)}`);
        }
    });
    await t('warn when the newest evidence row is stale (edge: scheduler stopped)', async () => {
        resetState();
        const rows = chainRows(3);
        stubChain(rows, { latest: new Date(Date.now() - 10 * 86400000).toISOString() });
        const r = await isoChecks.evidenceIntegrity.evaluate('x');
        assertStatus(r, 'warn', 'stale chain');
        if (r.evidence.age_days !== 10) {
            throw new Error(`expected the warning to name a 10-day-old head, got ${r.evidence.age_days}`);
        }
    });
    // ═══ end ISO 27001 governance fragment ══════════════════════════════════
};
const log = require('../../../telemetry/log');
