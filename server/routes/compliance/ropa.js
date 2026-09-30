/**
 * Compliance — the Records of Processing Activities: the synthesis, its PDF
 * rendition and the mark-as-reviewed stamp.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** The review button posts nothing; this stamp reads nothing out of a body. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const log = require('../../telemetry/log');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const userStore = require('../../stores/userStore');
const runner = require('../../compliance/runner');
const { getAll } = require('../../db');
const { SUPPLIER_ROW, NON_EU, LOC_STATE } = require('../../stores/integrationLocationSql');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');

// ───────────────── RoPA ─────────────────
//
// Auto-generated Records of Processing Activities. We synthesise the document
// from the system's existing knowledge (agents = purposes; integrations =
// processors; settings = controller + retention) so the admin only has to
// review and mark-as-reviewed rather than type it from scratch.

/**
 * The newest AI Act assessment per target, as `{ automation: {id: row}, … }`.
 * Missing table / fresh install → empty maps; the register then simply says
 * `ai_act: null` per activity, which is the honest answer.
 */
async function _assessments(orgId) {
    const out = { automation: {}, agent: {} };
    let rows = [];
    try { rows = await require('../../stores/aiActAssessmentStore').listForOrg(orgId); } catch { return out; }
    for (const r of rows || []) {
        if (!out[r.target_kind]) continue;
        out[r.target_kind][String(r.target_id)] = r;
    }
    return out;
}

/** The §1.2 `ai_act` block on an activity — allow-listed: outcome + stamps. */
function _aiActBlock(row) {
    if (!row) return null;
    return {
        outcome: row.outcome || null,
        attested_at: row.attested_at || null,
        expires_at: row.expires_at || null,
    };
}

/**
 * DORA Art. 28(3) register columns for one processor row. The admin-entered
 * facts live on the org's `scc_confirmed_operators` entries (written by
 * setSccConfirmed, which preserves contract_ref/critical/country); the
 * observed country stays the fallback so a register row is never blank just
 * because nobody filled the form in yet.
 */
function _sccEntryFor(list, operator) {
    return (Array.isArray(list) ? list : []).find(e => e && typeof e === 'object' && e.operator === operator) || null;
}

/**
 * A processor that took data to a known place outside Europe. Rows from a
 * reader without the location counts fall back on is_eu, as before.
 */
function _isThirdCountryProcessor(p) {
    if (p.outside_calls !== undefined && p.outside_calls !== null) return Number(p.outside_calls) > 0;
    return !p.is_eu;
}

async function _buildRopa(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const org = await userStore.getOrganization(orgId).catch(() => null);
        const assessments = await _assessments(orgId);

        let agents = [];
        try {
            // Concept/live split (A1): the register describes the processing
            // that actually runs, so read the published projection where one
            // exists (same COALESCE pair as art50-ai-disclosure / art35).
            agents = await getAll(`
                SELECT id, name, description, model,
                       COALESCE(published_system_prompt, system_prompt) AS system_prompt,
                       organization_id,
                       COALESCE(published_config::text, config::text) AS config,
                       is_published
                FROM agents WHERE is_published = TRUE
            `);
        } catch { /* fresh */ }
        agents = agents.filter(a => !a.organization_id || a.organization_id === orgId);

        let processors = [];
        try {
            // Rows flagged served_from_cache are deliberately INCLUDED. The
            // processor register asks "does this organisation use this
            // processor, and when did it last do so" — and a run that acted on
            // a stored answer is still that organisation processing personal
            // data obtained from them. Excluding cache hits would let a
            // processor drop out of an Art-30 record entirely once a cross-run
            // hit answers every call for a day. The Art-44 TRANSFER count is
            // the query that excludes them, because that one asks a different
            // question: did bytes actually leave.
            // Local calls are no processor, and a row with neither operator nor
            // location names nobody; a global network (Cloudflare, …) is one.
            // outside_calls / via_network_calls say which processors take data
            // out of Europe, and which only through a network whose final
            // location the connection cannot see.
            processors = await getAll(`
                SELECT operator,
                       MAX(country_code) AS country_code,
                       MAX(country_name) AS country_name,
                       BOOL_OR(is_eu) AS is_eu,
                       COUNT(*)::int AS calls,
                       COUNT(*) FILTER (WHERE ${NON_EU})::int AS outside_calls,
                       COUNT(*) FILTER (WHERE ${LOC_STATE} = 'via_network')::int AS via_network_calls,
                       MIN(timestamp) AS first_seen,
                       MAX(timestamp) AS last_seen
                FROM integration_activity_log
                WHERE organization_id = $1
                  AND timestamp >= NOW() - INTERVAL '180 days'
                  AND ${SUPPLIER_ROW}
                GROUP BY operator
                ORDER BY calls DESC
            `, [orgId]);
        } catch { /* fresh */ }

        const activities = agents.map(a => ({
            activity_id: a.id,
            name: a.name,
            purpose: a.description || 'AI-assisted user interaction',
            data_categories: ['Conversation content', 'User profile (when supplied)'],
            data_subjects: ['Authenticated users', 'External data subjects whose data is entered into conversations'],
            recipients: 'Processors listed below',
            // Third-country transfers: processors with located traffic outside
            // Europe. A processor seen only via a global network is not listed:
            // where it processes the data is not visible on the connection.
            transfers: processors.filter(_isThirdCountryProcessor).map(p => p.operator),
            // Only claim what is actually enforced: the retention job expires
            // stored memories; conversation content is NOT auto-deleted.
            retention: settings.default_retention_days
                ? `Stored memories: ${settings.default_retention_days} days (enforced automatically). Conversation content: not auto-deleted — governed by organisational policy.`
                : 'Org default not set — no automatic deletion.',
            security_measures: [
                'Encryption at rest (envelope AES-256-GCM)',
                'Encryption in transit (TLS)',
                'Access logging via guardrail_events',
                'DLP / PII redaction (where enabled)',
            ],
            // AI Act: the self-declared classification of this agent, if one
            // has been recorded. `null` = never assessed (the register says so
            // rather than implying "minimal").
            ai_act: _aiActBlock(assessments.agent[String(a.id)]),
        }));

        // The organisation's own Studio tables — where a workspace's personal
        // data actually lands. Opt-in: a table is here once someone recorded a
        // legal basis or a retention period for it (compliance/ropa).
        try {
            activities.push(...await require('../../compliance/ropa/datatableActivities').datatableActivities(orgId));
        } catch (e) {
            log.warn('[ROPA] datatable activities unavailable:', e.message);
        }

        // Collaborative projects with a recorded processing record (a lawful
        // basis or a retention period) — compliance/ropa/projectActivities.js.
        try {
            activities.push(...await require('../../compliance/ropa/projectActivities').projectActivities(orgId));
        } catch (e) {
            log.warn('[ROPA] project activities unavailable:', e.message);
        }

        // Product measurement.
        //
        // Every model call writes a row to `ai_usage_log` carrying the user,
        // the model, token counts, cost and — since the client column was
        // added — which client made it. That is personal data processed for a
        // purpose the agent list does not describe, so it belongs in the
        // record whether or not anyone ever queries it.
        //
        // Always present, unconditionally: this happens on every install,
        // because the operator is the controller of their own database. What
        // is optional is the aggregate push that can leave it, and that is a
        // separate row below when it is switched on.
        activities.push({
            activity_id: 'product-usage-metering',
            name: 'Usage metering and product measurement',
            purpose: 'Recording AI model usage per user for cost accounting, quota enforcement, and understanding which parts of the product are used.',
            data_categories: [
                'User identifier',
                'Model, token counts, duration and cost per call',
                'Originating client (web / android / api) and call source',
            ],
            data_subjects: ['Authenticated users'],
            recipients: 'None — stays in this installation.',
            transfers: [],
            retention: 'Retained with the account. Erased when the user is deleted.',
            security_measures: [
                'No message content is recorded on these rows',
                'Client is a closed enum; no screen names, taps, navigation or session durations are collected',
                'Included in the user-erasure cascade',
            ],
            ai_act: null,
        });

        // User research, when this installation actually runs it.
        //
        // Off by default and deliberately so: the row asserts that THIS
        // organisation studies its users, and auto-generating that claim into
        // every customer's register would make the register a false record.
        // The contract this row summarises is published at
        // docs/reference/user-research.
        if (process.env.RESEARCH_STUDIES_ENABLED === 'true') {
            activities.push({
                activity_id: 'user-research',
                name: 'Usability research with participants',
                purpose: 'Observed sessions, remote tasks and diary studies with people who agree to take part, to find out where the product fails them.',
                data_categories: [
                    'Screen recording of a supplied device loaded with fixture data',
                    'Observer notes',
                    'Participant first name and contact address',
                    'Consent record',
                ],
                data_subjects: ['Research participants who have given written consent'],
                recipients: 'None — recordings and notes stay with the research team.',
                transfers: [],
                retention: 'Recordings and notes destroyed 90 days after the session; anonymised findings only thereafter.',
                security_measures: [
                    'Sessions run on a fixture account holding invented documents; no participant or customer data is on the device',
                    'The fixture account is reset between sessions, so no participant sees the previous one\'s work',
                    'Participants are recruited through the customer administrator, never from the tenancy list',
                    'Withdrawal honoured on request at any time before the destruction date',
                    'No conversation content is read or stored as research material',
                ],
                ai_act: null,
            });
        }

        if (process.env.OPS_PUSH_ENABLED === 'true') {
            activities.push({
                activity_id: 'ops-metrics-push',
                name: 'Aggregate operational metrics export',
                purpose: 'Periodic export of aggregate counts (active users, runs, knowledge-base totals, interactive turns by client) to an operational metrics store configured by this installation.',
                data_categories: ['Aggregate counts only — no user identifiers'],
                data_subjects: ['None directly identified'],
                recipients: process.env.OPS_PUSH_URL ? 'Operational metrics store configured for this installation' : 'Not configured',
                transfers: [],
                retention: 'Governed by the receiving store.',
                security_measures: [
                    'Counts are aggregated per organisation before export; no per-user row leaves the database',
                    'Disabled unless OPS_PUSH_ENABLED is explicitly set',
                ],
                ai_act: null,
            });
        }

        const sccList = Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [];

        // DORA Art. 28(3) register of information: the observed processor rows
        // carry the admin's contract facts alongside the measured ones.
        // `country` is the ISO-2 the admin entered; `country_code` stays the
        // observed one, so a mismatch between the two is visible rather than
        // silently overwritten.
        const processorRows = (processors || []).map(p => {
            const e = _sccEntryFor(sccList, p.operator);
            return {
                ...p,
                contract_ref: e?.contract_ref || null,
                critical: typeof e?.critical === 'boolean' ? e.critical : null,
                country: e?.country || null,
                scc_confirmed: !!e,
                scc_attested_at: e?.attested_at || null,
            };
        });

        // AI Act register — every AUTOMATION with a recorded assessment (agent
        // assessments already ride on their activity row above). Allow-listed:
        // kind, id, title, outcome, stamps. No prompts, no run content.
        const automationAssessments = Object.values(assessments.automation || {});
        let titles = { automation: {}, agent: {} };
        if (automationAssessments.length) {
            try {
                titles = await require('../../compliance/aiAct/signals')
                    .titlesFor(orgId, automationAssessments.map(r => ({ target_kind: 'automation', target_id: r.target_id })));
            } catch { /* titles are a nicety, the register is not */ }
        }
        const ai_systems = automationAssessments
            .map(r => ({
                target_kind: 'automation',
                target_id: String(r.target_id),
                title: titles.automation?.[String(r.target_id)] || null,
                outcome: r.outcome || null,
                attested_at: r.attested_at || null,
                expires_at: r.expires_at || null,
            }))
            .sort((a, b) => String(b.attested_at || '').localeCompare(String(a.attested_at || '')));

        return {
            organization_id: orgId,
            controller: {
                name: org?.name || orgId,
                dpo_name: settings.dpo_name,
                dpo_email: settings.dpo_email,
                dpo_phone: settings.dpo_phone,
            },
            legal_bases: settings.legal_bases || [],
            data_residency: settings.data_residency || 'eu',
            generated_at: new Date().toISOString(),
            last_reviewed_at: settings.ropa_reviewed_at,
            last_reviewed_by: settings.ropa_reviewed_by,
            // Per-operator SCC attestations — the ROPA page renders its toggle
            // state from this list (kept in compliance_settings).
            scc_confirmed_operators: sccList,
            activities,
            ai_systems,
            processors: processorRows,
        };
}

router.get('/ropa', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.json(await _buildRopa(orgId));
});

// PDF rendition of the same synthesis — the document a DPO hands an auditor.
router.get('/ropa.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const ropa = await _buildRopa(orgId);
    const { buildRopaPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildRopaPdf(ropa);
    // Same as the other exports: the download never fails on the ledger,
    // but the failure is reported rather than dropped.
    const evidenceRow = {
        organization_id: orgId,
        check_id: 'GDPR-Art30-ropa-reviewed',
        subject_type: 'export',
        subject_id: 'ropa.pdf',
        hash,
        payload: { action: 'ropa_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash },
    };
    await complianceStore.addEvidence(evidenceRow).catch(onEvidenceWriteFailed(evidenceRow));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="ropa.pdf"');
    res.send(buffer);
});

router.post('/ropa/review', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    await complianceStore.markRopaReviewed(orgId, actorId);
    runner.runOne(orgId, 'GDPR-Art30-ropa-reviewed').catch(() => {});
    res.json({ ok: true, reviewed_at: new Date().toISOString(), reviewer: actorId });
});

// GET/PUT/DELETE /ropa/projects[/:projectId] — the processing record of
// collaborative projects (routes/compliance/projectRegistrations.js).
router.use(require('./projectRegistrations').makeProjectRegistrationRouter());

module.exports = router;
