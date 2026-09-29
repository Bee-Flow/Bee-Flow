/**
 * Machinery Regulation (EU) 2023/1230 Art. 3(3) / Annex III B §1.1.9
 * (indicative) — are there industrial control integrations?
 *
 * Software that controls or monitors a machine's safety function is a
 * "safety component"; the org that modifies a machine that way may become
 * its manufacturer. The platform cannot know what an automation drives, but
 * it can see industrial protocols and vendors in what the org configured and
 * where its traffic went (detectors/industrialIntegrations.js).
 *
 *   relevance override 'not_relevant'  → not_applicable (evidence.relevance)
 *   no matches                          → not_applicable with the scanned counts
 *                                         ("no industrial integrations detected")
 *   matches                             → warn — never fail; detection is a
 *                                         prompt to assess, the assessment is
 *                                         MACHINERY-Art18-safety-component-assessment
 *
 * Machinery relevance for the framework card is derived from this result
 * (matches > 0 → relevant, else unknown/not detected); an admin override in
 * `framework_relevance.machinery` wins. Sources the deployment has not
 * provisioned are listed under evidence.skipped, so a "0 matches" is never
 * mistaken for "everything was scanned".
 *
 * Evidence: per-source scan counts, the matches (source, id, label, signals,
 * confidence) and the heuristics version. Labels are integration/automation
 * names — never a user id or address; the detector strips URL userinfo.
 */

const complianceStore = require('../../../stores/complianceStore');
const detector = require('../../detectors/industrialIntegrations');

const MAX_MATCHES_IN_EVIDENCE = 50;
const MAX_SIGNALS_PER_MATCH = 8;

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return rel && typeof rel.machinery === 'string' ? rel.machinery : null;
}

function _slim(m) {
    return {
        source: m.source,
        id: m.id,
        label: String(m.label || m.id).slice(0, 120),
        confidence: m.confidence,
        signals: (m.signals || []).slice(0, MAX_SIGNALS_PER_MATCH).map(s => ({ kind: s.kind, value: String(s.value).slice(0, 160), label: s.label })),
        ...(m.scope ? { scope: m.scope } : {}),
        ...(m.active !== undefined ? { active: m.active } : {}),
    };
}

module.exports = {
    id: 'MACHINERY-Art3-industrial-detection',
    regulation: 'MACHINERY',
    article: 'Art. 3(3)',
    frameworks: [],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_machinery_detection_title',
    descriptionKey: 'compliance.check_machinery_detection_desc',
    remediationKey: 'compliance.check_machinery_detection_fix',
    remediationLink: 'admin/compliance/machinery',

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        const override = _relevance(settings);
        if (override === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The Machinery Regulation was marked not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const result = await detector.detect(orgId);
        const matches = Array.isArray(result.matches) ? result.matches : [];
        const high = matches.filter(m => m.confidence === 'high').length;
        const low = matches.length - high;
        const evidence = {
            scanned: result.scanned,
            skipped: result.skipped || [],
            matches: matches.slice(0, MAX_MATCHES_IN_EVIDENCE).map(_slim),
            match_count: matches.length,
            high_confidence: high,
            low_confidence: low,
            heuristics_version: result.heuristics_version,
            relevance_override: override,
            derived_relevance: matches.length ? 'relevant' : 'not_detected',
        };

        if (!matches.length) {
            const scannedTotal = Object.values(result.scanned || {}).reduce((n, v) => n + (Number(v) || 0), 0);
            const skippedNote = evidence.skipped.length ? ` ${evidence.skipped.length} source(s) not provisioned on this deployment (${evidence.skipped.map(s => s.source).join(', ')}).` : '';
            return {
                status: 'not_applicable',
                evidence,
                details: `No industrial integrations detected across ${scannedTotal} scanned item(s) (custom integrations ${result.scanned.custom_integrations}, automations ${result.scanned.automations}, connections ${result.scanned.connections}, activity hosts ${result.scanned.activity_hosts}, MCP servers ${result.scanned.mcp_servers}).${skippedNote}`,
            };
        }

        const named = matches.slice(0, 3).map(m => `${m.label} (${m.confidence})`).join(', ');
        return {
            status: 'warn',
            evidence,
            details: `${matches.length} integration(s) show industrial-control signals (${high} high, ${low} low confidence): ${named}${matches.length > 3 ? ', …' : ''}. Assess each one — does it control or monitor a safety function? — under Compliance → Machinery.`,
        };
    },
};
