/**
 * Compliance — the ISO 27001 evidence connectors: catalog, the vault
 * connections a connector may link, its per-org config and a manual sweep.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `ConnectorConfig` is `.strict()` over the three keys the drawer sends, and
 * `settings` stays a deliberately open object: each connector family owns its
 * own keys, the drawer edits them as raw JSON, and the hint the catalog ships
 * is the only description there is. The rest is pinned, because
 * isoEvidenceStore.upsertConfig answers a value it does not recognise by
 * keeping the one already on the row: `enabled: 'false'` (the string) is not a
 * boolean, so a connector an admin had just switched off went on sweeping,
 * under a 200. A misspelled `connectionId` was dropped just as quietly, and
 * the connector then ran with no credential at all.
 *
 * The sweep button posts `{}` and the route reads nothing from it.
 */

const express = require('express');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const ConnectorConfig = bodyOf({
    enabled: z.boolean({ invalid_type_error: 'enabled is true or false.' }).optional(),
    // `null` unlinks the vault connection — a credential-less probe needs none.
    connection_id: worded('connection_id must be a connection id.').trim().max(200, 'connection_id is at most 200 characters.').nullable().optional(),
    // Per-connector keys; the catalog's settings_hint is the contract.
    settings: z.record(z.unknown(), { invalid_type_error: 'settings is a JSON object.' }).optional(),
});

/** The sweep button posts `{}`. */
const NoBody = bodyOf({});

// ───────────────── ISO 27001 — evidence connectors ─────────────────
//
// Catalog + per-org config for the external-system evidence sweeps. Secrets
// stay in the integration_connections vault — a config only references a
// connection id; credential-less probes (DNS/TLS) need none.

router.get('/iso/connectors', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const isoConnectors = require('../../compliance/connectors');
    const isoEvidenceStore = require('../../stores/isoEvidenceStore');
    const configs = await isoEvidenceStore.listConfigs(orgId);
    const byId = new Map(configs.map(c => [c.connector_id, c]));
    const out = [];
    for (const c of isoConnectors.getAll()) {
        const cfg = byId.get(c.id) || null;
        let snapshots = 0;
        if (cfg?.enabled) {
            try { snapshots = (await isoEvidenceStore.listLatestSnapshots(orgId, c.id)).length; }
            catch { /* count stays 0 */ }
        }
        out.push({
            id: c.id,
            titleKey: c.titleKey,
            descKey: c.descKey,
            covered_controls: c.coveredControls || [],
            checks: c.checks || [],
            credential: c.credential || null,
            settings_hint: c.settingsHint || null,
            config: cfg ? {
                enabled: cfg.enabled,
                connection_id: cfg.connection_id,
                settings: cfg.settings || {},
                last_sweep_at: cfg.last_sweep_at,
                last_status: cfg.last_status,
                last_error: cfg.last_error,
            } : null,
            snapshots,
        });
    }
    res.json(out);
});

// Vault connections the caller may link for this connector's provider.
router.get('/iso/connectors/:id/connections', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const isoConnectors = require('../../compliance/connectors');
    const connector = isoConnectors.get(String(req.params.id));
    if (!connector) return res.status(404).json({ error: 'unknown connector' });
    if (!connector.credential) return res.json([]);
    const orgId = await resolveOrgId(req);
    const userId = req.session?.user?.id;
    const u = await userStore.getUser(userId).catch(() => null);
    const connStore = require('../../stores/integrationConnectionStore');
    const rows = await connStore.listAccessibleConnections({
        userId, orgId, groups: u?.groups || [], provider: connector.credential.provider,
    });
    res.json((rows || []).map(r => ({ id: r.id, label: r.label, kind: r.kind, provider: r.provider })));
});

router.put('/iso/connectors/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: ConnectorConfig }), async (req, res) => {
    const isoConnectors = require('../../compliance/connectors');
    const connector = isoConnectors.get(String(req.params.id));
    if (!connector) return res.status(404).json({ error: 'unknown connector' });
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const isoEvidenceStore = require('../../stores/isoEvidenceStore');
    const saved = await isoEvidenceStore.upsertConfig(orgId, connector.id, req.body, actorId);
    res.json(saved);
});

// Manual sweep — the connect-flow's "test" button and the admin's refresh.
router.post('/iso/connectors/:id/sweep', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const isoEvidenceStore = require('../../stores/isoEvidenceStore');
    const config = await isoEvidenceStore.getConfig(orgId, String(req.params.id));
    if (!config?.enabled) return res.status(400).json({ error: 'connector not enabled' });
    const { sweepOne } = require('../../jobs/isoEvidenceCollector');
    const result = await sweepOne(config);
    res.status(result.ok ? 200 : 502).json(result);
});

module.exports = router;
