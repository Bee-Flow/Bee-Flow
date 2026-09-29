/**
 * Compliance — the incident register: GDPR Art. 33/34 breaches (72-hour
 * workflow), NIS2 significant incidents, CRA actively-exploited
 * vulnerabilities (24 h early warning / 72 h notification / 14 d final report)
 * and the DORA customer notice. One table, one `kind`, clocks per regime;
 * attestation stamps go to the evidence chain; the internal breach-recipient
 * mailing stays as it was.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are `.strict()`, and on a statutory register that matters three
 * times over. incidentStore answers a value it does not recognise by keeping
 * what is already on the row:
 *
 *   - `status: 'authority_notifed'` (one letter short) left the row on its old
 *     status AND skipped this route's `body.status === 'authority_notified'`
 *     evidence write — an Art-33 notification an auditor samples, recorded
 *     nowhere, answered 200 with the row as proof;
 *   - `severity` outside the store's list fell back to 'medium' on create and
 *     was dropped on patch. The severity picker in agent-hub offers 'critical',
 *     so every critical incident ever recorded was filed as medium;
 *   - a misspelled key (`hgih_risk`, `authority_ref`) was dropped from the
 *     patch under a 200 carrying the unchanged row.
 *
 * `recipients_notified_at` is deliberately NOT in the patch schema: it is the
 * stamp POST /incidents/:id/notify-recipients writes once the mail transport
 * has accepted the message, and a request body must not be able to claim a
 * notification that never went out.
 *
 * `kind` and `regimes` keep their own 400s (`invalid_kind` / `invalid_regime`,
 * each naming what it allows) — the schema only pins that they are text, so
 * the richer message still reaches the caller.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const incidentStore = require('../../stores/incidentStore');
const runner = require('../../compliance/runner');
const frameworkPolicy = require('../../compliance/frameworkPolicy');
const events = require('../../compliance/events');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ───────────────── Incidents (GDPR Art. 33/34 · NIS2 · CRA · DORA) ─────────────────
//
// The registry records the workflow; "authority notified" / "CRA report sent"
// are record-only attestations (timestamp + actor + reference number) — the
// tool never files with a supervisory authority, CSIRT or ENISA on the org's
// behalf.

const CRA_CHECK_ID = 'CRA-Art14-vuln-reporting-clocks';
const BREACH_CHECK_ID = 'GDPR-Art33-breach-detection';
const CRA_EVENT = 'cra_vulnerability_reported';

const crypto = require('crypto');
function _recordIncidentEvidence(orgId, incidentId, payload, checkId = BREACH_CHECK_ID) {
    // The attestation the admin just made stands whatever the ledger does, but
    // a swallowed append leaves the trail claiming the attestation never
    // happened — so the rejection is reported, not dropped.
    const row = {
        organization_id: orgId,
        check_id: checkId,
        subject_type: 'incident',
        subject_id: String(incidentId),
        hash: crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex'),
        payload,
    };
    return complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
}

function _rerun(orgId, checkId) {
    runner.runOne(orgId, checkId, { runType: 'event' }).catch(() => {});
}

function _isCra(incident) {
    if (!incident) return false;
    if (incident.kind === 'vulnerability') return true;
    const regimes = Array.isArray(incident.regimes) ? incident.regimes : [];
    return regimes.includes('CRA');
}

function _stringList(v, max = 50, len = 200) {
    const list = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(/[,\s]+/) : []);
    return list.map(s => String(s || '').trim()).filter(Boolean).map(s => s.slice(0, len)).slice(0, max);
}

// ── What a body may carry ───────────────────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

// Mirrors incidentStore.VALID_SEVERITIES / VALID_STATUSES. Kept here rather
// than read off the store so the router still loads under a stubbed store.
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'assessing', 'early_warning_sent', 'authority_notified', 'reported', 'subjects_notified', 'closed'];
const STAGES = ['early_warning', 'full'];

/** Anything `new Date()` can read — the form posts a datetime-local value, not an ISO instant. */
const moment = (name) => worded(`${name} must be a date.`)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), `${name} must be a date.`);

/** The two list fields take a comma/newline string, plain names, or {name, version_range} rows. */
const nameList = z.union([
    z.string(),
    z.array(z.union([z.string(), z.object({ name: z.string().optional(), version_range: z.string().nullish() }).passthrough()])),
], { errorMap: () => ({ message: 'affected_products is a list of product names.' }) });

const TITLE_TEXT = 'An incident needs a title.';
const CreateIncident = bodyOf({
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(300, 'An incident title is at most 300 characters.'),
    description: worded('description must be text.').nullish(),
    // The picker in agent-hub offers all four; the store used to know three.
    severity: oneOf('severity', SEVERITIES).optional(),
    high_risk: z.boolean({ invalid_type_error: 'high_risk is true or false.' }).optional(),
    occurred_at: moment('occurred_at').nullish(),
    detected_at: moment('detected_at').nullish(),
    // Text only — the route answers a wrong VALUE with invalid_kind/invalid_regime.
    kind: worded('kind must be text.').nullish(),
    regimes: z.union([z.string(), z.array(z.string())], {
        errorMap: () => ({ message: 'regimes is a list of regulation codes.' }),
    }).nullish(),
    exploited_in_wild: z.boolean({ invalid_type_error: 'exploited_in_wild is true or false.' }).optional(),
    // The name this field had before `exploited_in_wild`; both still arrive.
    actively_exploited: z.boolean({ invalid_type_error: 'actively_exploited is true or false.' }).optional(),
    affected_products: nameList.nullish(),
    cve_ids: z.union([z.string(), z.array(z.string())], {
        errorMap: () => ({ message: 'cve_ids is a list of CVE identifiers.' }),
    }).nullish(),
    reported_via: worded('reported_via must be text.').trim().max(100, 'reported_via is at most 100 characters.').nullish(),
});

const PatchIncident = bodyOf({
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(300, 'An incident title is at most 300 characters.').optional(),
    description: worded('description must be text.').nullish(),
    severity: oneOf('severity', SEVERITIES).optional(),
    high_risk: z.boolean({ invalid_type_error: 'high_risk is true or false.' }).optional(),
    // The workflow step an auditor samples — never a near-miss spelling.
    status: oneOf('status', STATUSES).optional(),
    occurred_at: moment('occurred_at').nullish(),
    authority_reference: worded('authority_reference must be text.').trim().max(200, 'authority_reference is at most 200 characters.').nullish(),
    note: worded('note must be text.').max(2000, 'A note is at most 2000 characters.').optional(),
});

const CraReport = bodyOf({
    stage: oneOf('stage', STAGES),
    reported_via: worded('reported_via must be text.').trim().max(100, 'reported_via is at most 100 characters.').nullish(),
    reference: worded('reference must be text.').trim().max(200, 'reference is at most 200 characters.').nullish(),
});

const IncidentQuery = z.object({
    status: oneOf('status', STATUSES).optional(),
    // `kind` keeps the route's own invalid_kind answer, which lists what it allows.
    kind: worded('kind must be text.').optional(),
}).strict();

/** The stamp routes read nothing from the body; a key there is a mistake, not a default. */
const NoBody = bodyOf({});

/** 409 framework_disabled when the org has not enabled the CRA framework. */
async function _requireCra(req, orgId, res) {
    const active = await frameworkPolicy.activeRegulations(orgId, { req });
    if (active.has('CRA')) return true;
    res.status(409).json({ error: 'framework_disabled', regulation: 'CRA', framework: 'cra' });
    return false;
}

function _parseId(raw) {
    const id = parseInt(raw, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/incidents', requireAuth, requirePermission('admin_compliance'), validate({ query: IncidentQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    if (kind && !incidentStore.VALID_KINDS.includes(kind)) {
        return res.status(400).json({ error: 'invalid_kind', allowed: incidentStore.VALID_KINDS });
    }
    res.json(await incidentStore.listIncidents(orgId, { status: req.query.status, kind }));
});

router.post('/incidents', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateIncident }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const body = req.body || {};
        const kind = body.kind == null || body.kind === '' ? 'breach' : String(body.kind);
        if (!incidentStore.VALID_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'invalid_kind', allowed: incidentStore.VALID_KINDS });
        }
        let regimes;
        try {
            regimes = incidentStore.normalizeRegimes(body.regimes, kind);
        } catch (e) {
            return res.status(400).json({ error: 'invalid_regime', message: e.message, allowed: incidentStore.VALID_REGIMES });
        }
        // A CRA vulnerability without the CRA framework would start clocks
        // nobody watches — refuse instead of recording a silent obligation.
        if (kind === 'vulnerability' || regimes.includes('CRA')) {
            if (!(await _requireCra(req, orgId, res))) return;
        }
        const exploited = typeof body.exploited_in_wild === 'boolean' ? body.exploited_in_wild
            : typeof body.actively_exploited === 'boolean' ? body.actively_exploited : undefined;
        let customerNoticeHours;
        if (regimes.includes('DORA')) {
            const settings = await complianceStore.getSettings(orgId).catch(() => null);
            customerNoticeHours = settings?.dora_customer_notice_hours ?? undefined;
        }
        const incident = await incidentStore.createIncident({
            organization_id: orgId,
            title: body.title,
            description: body.description,
            severity: body.severity,
            high_risk: !!body.high_risk,
            occurred_at: body.occurred_at,
            detected_at: body.detected_at,
            source: 'manual',
            created_by: actorId,
            kind,
            regimes,
            exploited_in_wild: exploited,
            // The store's own `_products()` reads both shapes the form can
            // produce — plain names and {name, version_range} rows. Flattening
            // them here first turned every row agent-hub sends into the string
            // "[object Object]", which is what the drawer then displayed.
            affected_products: typeof body.affected_products === 'string'
                ? _stringList(body.affected_products)
                : (body.affected_products ?? []),
            cve_ids: _stringList(body.cve_ids, 50, 32),
            reported_via: body.reported_via,
            customerNoticeHours,
        });
        const isCra = _isCra(incident);
        await _recordIncidentEvidence(orgId, incident.id, {
            action: 'incident_created',
            incident_id: incident.id,
            kind: incident.kind,
            regimes: incident.regimes,
            title: incident.title,
            by: actorId,
            at: new Date().toISOString(),
        }, isCra ? CRA_CHECK_ID : BREACH_CHECK_ID);
        _rerun(orgId, BREACH_CHECK_ID);
        if (isCra) _rerun(orgId, CRA_CHECK_ID);
        res.status(201).json(incident);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.patch('/incidents/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: PatchIncident }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const id = parseInt(req.params.id, 10);
        const updated = await incidentStore.updateIncident(orgId, id, req.body || {}, actorId);
        if (!updated) return res.status(404).json({ error: 'not found' });
        // Attestation stamps (authority/subjects notified) belong in the
        // immutable evidence chain.
        if (req.body?.status === 'authority_notified' || req.body?.status === 'subjects_notified') {
            await _recordIncidentEvidence(orgId, id, {
                action: req.body.status,
                incident_id: id,
                reference: req.body.authority_reference || null,
                by: actorId,
                at: new Date().toISOString(),
            });
        }
        _rerun(orgId, BREACH_CHECK_ID);
        if (_isCra(updated)) _rerun(orgId, CRA_CHECK_ID);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// CRA Art. 14 — record that the early warning (24 h) or the full notification /
// final report was submitted to the CSIRT / ENISA single reporting platform.
// Record-only: timestamp, channel and reference number.
router.post('/incidents/:id/cra-report', requireAuth, requirePermission('admin_compliance'), validate({ body: CraReport }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const id = _parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'not found' });
        const body = req.body;
        const incident = await incidentStore.getIncident(orgId, id);
        if (!incident) return res.status(404).json({ error: 'not found' });
        if (!_isCra(incident)) return res.status(409).json({ error: 'not_cra_incident', message: 'This incident is not under the CRA regime.' });
        if (!(await _requireCra(req, orgId, res))) return;
        const updated = await incidentStore.stampCraReport(orgId, id, {
            stage: body.stage,
            reportedVia: body.reported_via,
            reference: body.reference,
            by: actorId,
        });
        const at = new Date().toISOString();
        await _recordIncidentEvidence(orgId, id, {
            action: 'cra_report',
            stage: body.stage,
            incident_id: id,
            reported_via: body.reported_via ? String(body.reported_via).slice(0, 100) : null,
            reference: body.reference ? String(body.reference).slice(0, 200) : null,
            by: actorId,
            at,
        }, CRA_CHECK_ID);
        events.emit(CRA_EVENT, { orgId, incidentId: id, stage: body.stage, actorId, at });
        _rerun(orgId, CRA_CHECK_ID);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// DORA / CRA — the customer notice went out (record-only; the notice itself
// is the org's own communication, this stamps when).
router.post('/incidents/:id/customer-notified', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const id = _parseId(req.params.id);
        if (!id) return res.status(404).json({ error: 'not found' });
        const incident = await incidentStore.getIncident(orgId, id);
        if (!incident) return res.status(404).json({ error: 'not found' });
        const updated = await incidentStore.stampCustomerNotified(orgId, id, actorId);
        await _recordIncidentEvidence(orgId, id, {
            action: 'customer_notified',
            incident_id: id,
            regimes: Array.isArray(incident.regimes) ? incident.regimes : [],
            by: actorId,
            at: new Date().toISOString(),
        }, _isCra(incident) ? CRA_CHECK_ID : BREACH_CHECK_ID);
        _rerun(orgId, BREACH_CHECK_ID);
        if (_isCra(incident)) _rerun(orgId, CRA_CHECK_ID);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Email the org's configured breach recipients about this incident. Internal
// alerting only — supervisory-authority notification stays a human act.
//
// ── BFSF-441: the addresses go to the transport, never to the ledger ────────
// The recipient addresses are the CHANNEL — they have to reach the mail
// transport or nothing is delivered. They stop there. What lands in
// `compliance_evidence` is what an auditor actually needs from this act: that a
// notification went out, over which channel, to how many recipients, when, and
// on whose authority. The chain is append-only and hash-linked, so an address
// written into it could never be corrected or withdrawn again — an Art-17
// erasure request against the breach-recipient list would have nowhere to land.
// A count carries the same evidentiary weight and none of the personal data.
//
// The payload is therefore assembled field by field from the allow-list below,
// never by copying `settings`, the incident row or the recipient list and
// deleting keys: a column added to either next year would otherwise walk into
// the ledger by itself.
const NOTIFY_CHANNEL = 'email';
router.post('/incidents/:id/notify-recipients', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    const id = _parseId(req.params.id);
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        if (!id) return res.status(404).json({ error: 'not found' });
        const incident = await incidentStore.getIncident(orgId, id);
        if (!incident) return res.status(404).json({ error: 'not found' });
        const settings = await complianceStore.getSettings(orgId);
        const recipients = (Array.isArray(settings.breach_recipients) ? settings.breach_recipients : [])
            .filter(r => typeof r === 'string' && r.includes('@'));
        if (!recipients.length) {
            return res.status(400).json({ error: 'no_breach_recipients', message: 'Add breach notification recipients under Compliance → Settings first.' });
        }
        const { sendBreachNotificationEmail } = require('../../utils/emailService');
        try {
            await sendBreachNotificationEmail({
                to: recipients,
                incidentSummary: `${incident.title}${incident.description ? ` — ${incident.description}` : ''}`,
                occurredAt: incident.occurred_at || incident.detected_at,
                ackUrl: `${process.env.PUBLIC_APP_URL || ''}${require('../../utils/appPaths').complianceIncidentPath(id)}`,
            });
        } catch (mailErr) {
            // Nothing went out, so nothing is stamped and nothing is recorded:
            // an evidence row here would attest to a notification that never
            // happened, and the chain cannot take it back.
            //
            // The refusal carries a code, never the transport's own message — an
            // SMTP rejection routinely quotes the address it could not deliver to
            // ("550 5.1.1 <name@example.com>: recipient unknown"), which is
            // exactly the string that must not reach a response body or a log.
            log.error(`[Compliance] breach notification failed for incident ${id} (${mailErr?.code || mailErr?.name || 'Error'})`);
            return res.status(502).json({
                error: 'notification_failed',
                message: 'The breach notification could not be sent. Check the mail settings and try again.',
            });
        }
        const updated = await incidentStore.updateIncident(orgId, id, {
            recipients_notified_at: new Date().toISOString(),
        }, actorId);
        await _recordIncidentEvidence(orgId, id, {
            action: 'recipients_notified',
            incident_id: id,
            channel: NOTIFY_CHANNEL,       // how it went out
            recipient_count: recipients.length, // to how many — never to whom
            by: actorId,                   // on whose authority
            at: new Date().toISOString(),  // when
        });
        res.json({ ok: true, notified: recipients.length, incident: updated });
    } catch (e) {
        // `e.message` can be a Postgres error quoting the row value that broke
        // it, or a settings read carrying the recipient list — it stays out of
        // the response and out of the log (finding 5's reasoning, same table).
        log.error(`[Compliance] notify-recipients failed for incident ${id} (${e?.code || e?.name || 'Error'})`);
        res.status(500).json({ error: 'notify_failed', message: 'Could not send the breach notification.' });
    }
});

module.exports = router;
module.exports.CRA_CHECK_ID = CRA_CHECK_ID;
module.exports.CRA_EVENT = CRA_EVENT;
