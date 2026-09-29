/**
 * Machinery Regulation (EU) 2023/1230 Art. 18 (substantial modification) /
 * Art. 10 (manufacturer obligations) — indicative refs — a safety-component
 * assessment is recorded for every industrial integration.
 *
 * Per-source, pure ATTESTATION. Subjects = the detector's matches
 * (detectors/industrialIntegrations.js) ∪ `settings.machinery_manual_subjects`
 * (integrations the admin adds by hand — a PLC bridge the heuristics cannot
 * see). Each subject needs an engineering judgement the platform cannot make:
 * does this software control or monitor a safety function, and does the
 * modification make the org the machine's manufacturer?
 *
 * The answer lives in the shared append-only `compliance_attestations` table
 * (stores/customFrameworkStore.latestAttestation, guarded — with a direct
 * SELECT as fallback while that store is not present), keyed by
 * (check_id = this id, subject_id). The store's outcome vocabulary is the
 * generic compliant|partial|non_compliant|not_applicable; the machinery
 * classification rides in the statement as a leading marker
 * `[safety_component]` | `[monitoring_only]` | `[not_safety_component]`
 * (or in a `classification` column if the store grows one). Both are read.
 *
 *   no subjects                                   → (runner) not_applicable
 *   no attestation                                → fail
 *   attestation older than 365 d / expires_at past → warn (re-assess)
 *   classification safety_component               → pass, evidence
 *                                                    requires_conformity_assessment: true
 *   monitoring_only / not_safety_component        → pass
 *   generic: compliant → pass · partial → warn · non_compliant → fail ·
 *            not_applicable → not_applicable
 *
 * Evidence: subject, signals, outcome, classification, attested_at, age,
 * expiry, evidence-ref count. attested_by is a user id in the table; it is
 * NOT copied into the evidence (BFSF-441) — the attestation row itself is
 * the audited record.
 */

const complianceStore = require('../../../stores/complianceStore');
const detector = require('../../detectors/industrialIntegrations');

const MAX_AGE_DAYS = 365;
const NOT_PROVISIONED = new Set(['42P01', '42703']);
const CLASSIFICATIONS = new Set(['safety_component', 'monitoring_only', 'not_safety_component']);
const MARKER_RE = /^\s*\[\s*(safety_component|monitoring_only|not_safety_component)\s*\]/i;

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.machinery === 'not_relevant';
}

function _manualSubjects(settings) {
    let list = settings && settings.machinery_manual_subjects;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (typeof item === 'string' && item.trim()) {
            const id = item.trim().slice(0, 120);
            out.push({ id: `manual:${id}`, label: id, name: id, source: 'manual', signals: [], confidence: 'manual' });
        } else if (item && typeof item === 'object' && (item.id || item.label || item.name)) {
            const id = String(item.id || item.label || item.name).trim().slice(0, 120);
            const label = String(item.label || item.name || id).trim().slice(0, 120);
            out.push({ id: `manual:${id}`, label, name: label, source: 'manual', signals: [], confidence: 'manual', note: typeof item.note === 'string' ? item.note.slice(0, 200) : undefined });
        }
    }
    return out;
}

async function _latestAttestation(orgId, checkId, subjectId) {
    let store = null;
    try { store = require('../../../stores/customFrameworkStore'); } catch { store = null; }
    if (store && typeof store.latestAttestation === 'function') {
        return store.latestAttestation(orgId, checkId, subjectId);
    }
    const { getOne } = require('../../../db');
    return getOne(`
        SELECT id, check_id, subject_id, outcome, statement, evidence_refs, attested_at, expires_at, superseded_at
          FROM compliance_attestations
         WHERE organization_id = $1 AND check_id = $2 AND subject_id = $3 AND superseded_at IS NULL
         ORDER BY attested_at DESC
         LIMIT 1
    `, [orgId, checkId, subjectId]);
}

function _classification(row) {
    if (!row) return null;
    if (typeof row.classification === 'string' && CLASSIFICATIONS.has(row.classification)) return row.classification;
    if (typeof row.outcome === 'string' && CLASSIFICATIONS.has(row.outcome)) return row.outcome;
    const m = typeof row.statement === 'string' ? row.statement.match(MARKER_RE) : null;
    return m ? m[1].toLowerCase() : null;
}

function _iso(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function _evidenceRefCount(v) {
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.length : 0; } catch { return 0; } }
    return 0;
}

module.exports = {
    id: 'MACHINERY-Art18-safety-component-assessment',
    regulation: 'MACHINERY',
    article: 'Art. 18',
    frameworks: [],
    severity: 'high',
    scope: 'per-source',
    verification: 'attestation',
    titleKey: 'compliance.check_machinery_assessment_title',
    descriptionKey: 'compliance.check_machinery_assessment_desc',
    remediationKey: 'compliance.check_machinery_assessment_fix',
    remediationLink: 'admin/compliance/machinery',
    MAX_AGE_DAYS,
    CLASSIFICATIONS: Array.from(CLASSIFICATIONS),

    async listSubjects(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (_notRelevant(settings)) return [];
        const seen = new Set();
        const out = [];
        let detected;
        try { detected = await detector.detect(orgId); } catch { detected = { matches: [] }; }
        for (const m of detected.matches || []) {
            const id = `${m.source}:${m.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({
                id,
                label: String(m.label || m.id).slice(0, 120),
                name: String(m.label || m.id).slice(0, 120),
                source: m.source,
                confidence: m.confidence,
                signals: (m.signals || []).slice(0, 8).map(s => ({ kind: s.kind, value: String(s.value).slice(0, 160) })),
                ...(m.scope ? { scope: m.scope } : {}),
            });
        }
        for (const s of _manualSubjects(settings)) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            out.push(s);
        }
        return out;
    },

    async evaluate(orgId, subject, opts = {}) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The Machinery Regulation was marked not relevant for this organisation (Compliance → Frameworks).',
            };
        }
        if (!subject?.id) {
            return { status: 'not_applicable', evidence: { subjects: 0 }, details: 'No industrial integration to assess.' };
        }
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const evidence = {
            subject_id: subject.id,
            subject_label: subject.label || subject.id,
            source: subject.source || null,
            confidence: subject.confidence || null,
            signals: Array.isArray(subject.signals) ? subject.signals : [],
            attested: false,
            outcome: null,
            classification: null,
            attested_at: null,
            age_days: null,
            expires_at: null,
            expired: false,
            evidence_refs: 0,
            requires_conformity_assessment: false,
        };

        let row = null;
        try {
            row = await _latestAttestation(orgId, module.exports.id, subject.id);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return { status: 'warn', evidence: { ...evidence, reason: 'not provisioned yet' }, details: 'not provisioned yet' };
            }
            throw e;
        }

        if (!row) {
            return {
                status: 'fail',
                evidence,
                details: `No safety-component assessment recorded for "${evidence.subject_label}"${subject.source ? ` (${subject.source}${subject.confidence ? `, ${subject.confidence} confidence` : ''})` : ''}. Decide whether it controls or monitors a safety function and record the assessment under Compliance → Machinery.`,
            };
        }

        const attestedAt = new Date(row.attested_at).getTime();
        const ageDays = Number.isFinite(attestedAt) ? Math.floor((now - attestedAt) / 86400e3) : null;
        const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
        const expired = (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) || (ageDays !== null && ageDays > MAX_AGE_DAYS);
        const classification = _classification(row);

        Object.assign(evidence, {
            attested: true,
            outcome: row.outcome || null,
            classification,
            attested_at: _iso(row.attested_at),
            age_days: ageDays,
            expires_at: _iso(row.expires_at),
            expired,
            evidence_refs: _evidenceRefCount(row.evidence_refs),
            requires_conformity_assessment: classification === 'safety_component',
        });

        if (expired) {
            return {
                status: 'warn',
                evidence,
                details: `The assessment of "${evidence.subject_label}" is ${ageDays} days old${expiresAt !== null && expiresAt <= now ? ' and past its expiry' : ''} — assessments are re-confirmed at least yearly (${MAX_AGE_DAYS} d). Re-assess under Compliance → Machinery.`,
            };
        }

        if (classification === 'safety_component') {
            return {
                status: 'pass',
                evidence,
                details: `"${evidence.subject_label}" is assessed as a SAFETY COMPONENT (${_iso(row.attested_at).slice(0, 10)}). It falls under the Machinery Regulation's conformity-assessment and CE-marking duties (Art. 10, Annex I) — keep the technical documentation and risk assessment with this record.`,
            };
        }
        if (classification === 'monitoring_only' || classification === 'not_safety_component') {
            return {
                status: 'pass',
                evidence,
                details: `"${evidence.subject_label}" is assessed as ${classification === 'monitoring_only' ? 'monitoring only — it does not control a safety function' : 'not a safety component'} (${_iso(row.attested_at).slice(0, 10)}).`,
            };
        }

        switch (row.outcome) {
            case 'compliant':
                return { status: 'pass', evidence, details: `Assessment recorded for "${evidence.subject_label}" (${_iso(row.attested_at).slice(0, 10)}): compliant.` };
            case 'partial':
                return { status: 'warn', evidence, details: `The assessment of "${evidence.subject_label}" is marked partial — complete it (classification and, for a safety component, the conformity assessment) under Compliance → Machinery.` };
            case 'non_compliant':
                return { status: 'fail', evidence, details: `"${evidence.subject_label}" is assessed as non-compliant — a safety component without a completed conformity assessment. Resolve before the Regulation applies (20 Jan 2027).` };
            case 'not_applicable':
                return { status: 'not_applicable', evidence, details: `Assessed as not applicable for "${evidence.subject_label}" (${_iso(row.attested_at).slice(0, 10)}).` };
            default:
                return { status: 'warn', evidence, details: `The assessment of "${evidence.subject_label}" carries an unknown outcome "${row.outcome}" — re-record it with a classification.` };
        }
    },
};
