/**
 * Compliance — the check-registry endpoint: every check definition the UI
 * needs to label and link a row, plus the static framework catalogue and the
 * ISO Annex A control catalogue.
 *
 * Response: { checks, frameworks, controls, themes }. Everything here is
 * static (no org state, no scores) — per-org framework state lives on
 * GET /frameworks, per-org results on GET /checks. The historic array shape
 * (`res.json([...])`) is gone; the demo catalogue generator emits this object.
 */

// ── Why GET /registry has no schema ──────────────────────────
//
// It is the static catalogue of check definitions: the same answer for every
// caller in the deployment, with no org and no parameters — the handler takes
// `_req` and never looks at it. There is nothing to validate.

const express = require('express');
const router = express.Router();

const registry = require('../../compliance/registry');
const frameworks = require('../../compliance/frameworks');
const { THEMES, CONTROLS } = require('../../compliance/iso/controls');
const { requireAuth, requirePermission } = require('../../auth/permissions');

function serializeCheck(c) {
    return {
        id: c.id, regulation: c.regulation, article: c.article,
        framework_id: frameworks.frameworkIdOf(c.regulation),
        frameworks: Array.isArray(c.frameworks) ? c.frameworks : [],
        in_force_since: c.in_force_since ?? frameworks.inForceSince(c.regulation, c.article),
        severity: c.severity, scope: c.scope,
        verification: c.verification || 'automated',
        titleKey: c.titleKey, descriptionKey: c.descriptionKey,
        remediationKey: c.remediationKey, remediationLink: c.remediationLink || null,
        autoFixId: c.autoFixId || null,
    };
}

// The catalogue entry without the RegExp (not JSON) — the client only needs
// identifiers, dates, phases, registers and the i18n keys.
function serializeFramework(f) {
    return {
        id: f.id,
        regulation: f.regulation,
        core: !!f.core,
        capability: f.capability,
        regulation_code: f.regulation_code,
        in_force_since: f.in_force_since || null,
        in_force_from: f.in_force_from || null,
        phases: f.phases || [],
        registers: f.registers || [],
        relevance_gate: !!f.relevance_gate,
        name_key: f.name_key,
        description_key: f.description_key,
        affects_key: f.affects_key,
    };
}

function buildRegistry() {
    return {
        checks: registry.getAll().map(serializeCheck),
        frameworks: frameworks.listBuiltin().map(serializeFramework),
        controls: CONTROLS,
        themes: THEMES,
    };
}

// ───────────────── Meta ─────────────────

router.get('/registry', requireAuth, requirePermission('admin_compliance'), async (_req, res) => {
    res.json(buildRegistry());
});

module.exports = router;
module.exports.buildRegistry = buildRegistry;
module.exports.serializeCheck = serializeCheck;
module.exports.serializeFramework = serializeFramework;
