/**
 * EU AI Act Art. 50(2) — AI-generated content is marked in a machine-readable
 * format and detectable as artificially generated.
 *
 * Per-source: one subject per automation whose document step (generate_document,
 * fill_document or presentation) draws on a model (an ai_step /
 * data_extraction / ai_tool upstream — summarize is an aggregate, not AI).
 * The graph reading is automation/automationGraph.js, the same one the AI-Act
 * signals and the runtime marking use, so what this check lists is exactly
 * what execDocument / execPresentation mark.
 *
 * The verdict is the org's switch: compliance_settings.ai_content_marking_enabled.
 * When it is on, every listed automation passes — documentRenderer prints the
 * footer and writes the PDF/DOCX metadata for all of them. When it is off the
 * status follows the calendar: Art. 50 applies since 2 Aug 2026, but content
 * from systems that predate it enjoys a transition until 2 Dec 2026
 * (frameworks.js milestone `aia_marking_transition_end`), so before that date
 * the row WARNS with the days left, and from that date on it FAILS.
 *
 * Scope note for the remediation copy: this is Info-dictionary / core-property
 * marking plus a visible line. Full C2PA content credentials (signed
 * provenance manifests) are out of scope for this release.
 */

const complianceStore = require('../../../stores/complianceStore');
const frameworks = require('../../frameworks');

const CHECK_ID = 'AIA-Art50-content-marking';
const MILESTONE_ID = 'aia_marking_transition_end';
const FALLBACK_DEADLINE = '2026-12-02';
const DAY_MS = 86400e3;
const SUBJECT_LIMIT = 500;

/** The transition-end date from the catalogue (single source), else the literal. */
function deadline() {
    const ms = Array.isArray(frameworks.MILESTONES) ? frameworks.MILESTONES.find(m => m && m.id === MILESTONE_ID) : null;
    const iso = (ms && ms.date) || FALLBACK_DEADLINE;
    return new Date(`${iso}T00:00:00Z`);
}

function _signals() {
    // Lazy: signals.js pulls in the Art. 50(1) check and the db; a check file
    // must stay cheap to require at boot.
    return require('../../aiAct/signals');
}

/** Days from `now` until the deadline, rounded up; 0 or negative once it has passed. */
function daysUntil(deadlineAt, now = new Date()) {
    return Math.ceil((deadlineAt.getTime() - now.getTime()) / DAY_MS);
}

function formatDeadline(d) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function _markingEnabled(orgId) {
    const settings = await complianceStore.getSettings(orgId);
    return !!(settings && settings.ai_content_marking_enabled);
}

module.exports = {
    id: CHECK_ID,
    regulation: 'AIA',
    article: '50(2)',
    severity: 'high',
    scope: 'per-source',
    verification: 'automated',
    titleKey: 'compliance.check_aia_art50_marking_title',
    descriptionKey: 'compliance.check_aia_art50_marking_desc',
    remediationKey: 'compliance.check_aia_art50_marking_fix',
    remediationLink: 'admin/compliance/settings',

    /** [{ id: <automationId>, label, generating: [...], aiStepIds, is_active, is_draft }] — titles only, no owner data. */
    async listSubjects(orgId) {
        const rows = await _signals().listGeneratingAutomations(orgId);
        return rows.slice(0, SUBJECT_LIMIT).map(r => ({
            id: String(r.id),
            label: r.title || String(r.id),
            is_active: !!r.is_active,
            is_draft: !!r.is_draft,
            aiStepIds: r.aiStepIds,
            generating: r.generating,
        }));
    },

    async evaluate(orgId, subject, { now = new Date() } = {}) {
        const enabled = await _markingEnabled(orgId);
        const due = deadline();
        const days = daysUntil(due, now);
        const evidence = {
            automation_id: subject ? subject.id : null,
            marking_enabled: enabled,
            generating_steps: subject && Array.isArray(subject.generating) ? subject.generating.map(g => ({ id: g.id, signal: g.signal, ai_step_ids: g.aiStepIds })) : [],
            ai_step_ids: subject && Array.isArray(subject.aiStepIds) ? subject.aiStepIds : [],
            is_active: subject ? !!subject.is_active : null,
            required_from: due.toISOString().slice(0, 10),
            days_until_required: days,
        };
        if (enabled) {
            return {
                status: 'pass',
                evidence,
                details: `AI content marking is on: documents this automation generates carry the visible line and the machine-readable metadata (EU AI Act Art. 50(2)).`,
            };
        }
        if (days > 0) {
            return {
                status: 'warn',
                evidence,
                details: `AI content marking is off: required from ${formatDeadline(due)} (in ${days} day${days === 1 ? '' : 's'}). Switch it on under Compliance → Settings.`,
            };
        }
        return {
            status: 'fail',
            evidence,
            details: `AI content marking is off and required since ${formatDeadline(due)}: documents this automation generates from model output are not marked as AI-generated. Switch it on under Compliance → Settings.`,
        };
    },

    _test: { deadline, daysUntil, MILESTONE_ID, FALLBACK_DEADLINE },
};
