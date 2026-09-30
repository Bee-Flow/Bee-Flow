/**
 * The org shield's server contract, pinned against the server's own source
 * (read as text, like core/api/serverContract.test.ts): the routes this
 * feature calls, the keys the PUT accepts and rebuilds, and the response keys
 * the readers rely on. A red line here means the server changed under the
 * phone: port the change, don't loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ECHOED_KEYS } from '../model/fields';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const shield = read('routes/orgPrivacyShield.js');
const orgShieldCore = read('core/privacy/orgShield.js');
const shieldDoc = read('core/privacy/customTypes/shieldDoc.js');
const usage = read('routes/usage.js');
const guardStore = read('stores/guardrailEventStore.js');
const integStore = read('stores/integrationActivityStore.js');
const integOverview = read('stores/integrationOverview.js');
const aiConfig = read('routes/ai/config/instanceConfig.js');
const tiers = read('routes/ai/config/modelTiers.js');

function expectAll(source: string, needles: readonly string[]): void {
    expect(needles.filter((n) => !source.includes(n))).toEqual([]);
}

describe('routes/orgPrivacyShield.js', () => {
    it('serves the routes this feature calls', () => {
        expectAll(shield, [
            "router.get('/:orgId', requireAuth",
            "router.put('/:orgId', requireAuth, validate({ body: OrgShieldBody })",
            "router.get('/user/guard-status', requireAuth",
            'isOrgAdmin(req, orgId)',
        ]);
    });

    it('accepts every key buildPayload sends', () => {
        const shape = /const ORG_SHAPE = \{([\s\S]*?)\n\};/.exec(shield)?.[1] ?? '';
        for (const key of [
            'enabled', 'euModeEnabled', 'webSearchGuardEnabled', 'disableSearchOnUpload', 'monitorIntegrations',
            'applyToAutomations', 'dlpEnabled', 'dlpMode', 'dlpAlwaysReview', 'customSensitiveTerms', 'piiAllowTerms',
            'piiAllowPublicOrgs', 'toolPiiPolicy', 'piiDetectionCategories', 'piiDetectionConfidenceThreshold',
            'piiDetectionAction', 'piiFailureMode', 'privacy_scan_knowledge_bases', 'showRawPayload',
        ]) {
            expect(shape).toContain(`${key}:`);
        }
        expectAll(shield, ["choice(['ask', 'auto_redact', 'block']", ".min(0.1, THRESHOLD_TEXT).max(1, THRESHOLD_TEXT)"]);
    });

    it('ignores exactly the echoed keys the phone strips', () => {
        const echoed = /const ECHOED = new Set\(\[([^\]]*)\]\)/.exec(shield)?.[1] ?? '';
        for (const key of ECHOED_KEYS) expect(echoed).toContain(`'${key}'`);
    });

    it('answers with the keys the readers read', () => {
        expectAll(shield, [
            'responseConfig.clamped_fields = clampedFields',
            'responseConfig.clamped_tier = clamps.tier',
            'config.stalenessWarnings = resolved.stalenessWarnings',
            'const response = { ok: true, config: responseConfig, termErrors, typeErrors }',
            "clamped.push('toolPiiPolicy.external')",
            "res.json({ configured: true, reachable: !!health })",
            'updatedAt: new Date().toISOString()',
            'updatedBy: req.session.user.id',
        ]);
        expectAll(orgShieldCore, ["stalenessWarnings.push({ collectionId: colId, reason: 'collection_not_found' })"]);
        // The old "Always hide these" list is validated with the data types now,
        // and still answered per term (kept for one release).
        expectAll(shieldDoc, ['termErrors.push({ id: term.id || null, label: term.label, error: err.message })']);
    });
});

describe('the environment reads', () => {
    it('still serve the search provider and the EU tier map', () => {
        expectAll(aiConfig, ["router.get('/config', requireAuth", 'searchProvider:']);
        expectAll(tiers, ["router.get('/config/chat-models-eu', requireAuth", "modelId: ''"]);
    });
});

describe('the activity endpoints (routes/usage.js)', () => {
    it('serve the routes and query keys this feature sends', () => {
        expectAll(usage, [
            "router.get('/guardrails/overview'",
            "router.get('/guardrails/recent'",
            "router.get('/integrations/overview'",
            "router.get('/integrations/egress'",
            "router.use('/guardrails', requireMonitoringScope)",
            "router.use('/integrations', requireMonitoringScope)",
            'days: wholeNumber(',
            "interval: choice(['hour', 'day']",
            'limit: wholeNumber(',
            'Math.min(parseInt(req.query.limit, 10) || 50, 200)',
            'display_name: info?.display_name',
        ]);
    });

    it('return the fields the readers read', () => {
        expectAll(guardStore, [
            'as total_events', 'as pii_count', 'as dlp_blocked', 'as unique_users',
            'top_categories: topCategories', 'top_users: topUsers', 'last_event_at',
            'violation_type, violation_categories, direction,', 'action_taken, source, model',
            'automation_id',
        ]);
        // The overview moved to its own module (per destination host, with a map).
        expectAll(integOverview, [
            'AS total_calls', 'AS non_eu_count', 'AS pii_non_eu_count', 'AS blocked_count',
            'sovereignty_score: score', 'score_delta: scoreDelta',
            'destinations: mapDestinations.slice(0, TOP_DESTINATIONS)', 'destinations: mapDestinations,',
            'country_code: r.country_code', 'country_name: r.country_name', "is_eu: r.location_state === 'eu'",
            "is_local: r.location_state === 'local'", 'total: Number(r.total)', 'pii_events: Number(r.pii_events)',
            "pii_categories: _rollupByCategory(piiRows, 'category'",
        ]);
        expectAll(integStore, [
            "require('./integrationOverview').buildOverview",
            'tool_name, integration_type, server_endpoint, dest_host', 'country_code, country_name, is_eu',
            'pii_categories_detected, status',
        ]);
    });
});
