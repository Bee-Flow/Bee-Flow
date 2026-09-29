/**
 * incidentClocks — the regulatory clocks of one incident row, React-free.
 *
 * One register (`compliance_incidents`) carries three kinds of row:
 * `breach` and `security_incident` (the Incidents section) and `vulnerability`
 * (the Vulnerability register, CRA Art. 14). The server computes the due
 * dates per regime and stores the EARLIEST of each stage
 * (`early_warning_due_at`, `deadline_at`, `final_report_due_at`,
 * `customer_notice_due_at`); this module reads those columns and, for a
 * vulnerability row from before BE-1c landed, derives the CRA stages from
 * `detected_at` (24 h · 72 h · 14 d) so the register never shows a row
 * without its clock.
 *
 * `urgentBelowMs` is REGULATION, not presentation (deadlineMath contract):
 * GDPR/NIS2 notification 24 h, CRA early warning 6 h, CRA later stages 24 h.
 */
import { HOUR_MS, DAY_MS } from '../../../../shared/deadlineMath';

export const INCIDENT_KINDS = Object.freeze(['breach', 'security_incident', 'vulnerability']);

/** The register a section id shows. */
export function kindsOfSection(sectionId) {
    return sectionId === 'vulnerabilities'
        ? Object.freeze(['vulnerability'])
        : Object.freeze(['breach', 'security_incident']);
}

export function isVulnerability(incident) {
    return incident?.kind === 'vulnerability';
}

/** A row without `kind` predates the column and is a GDPR breach. */
export function kindOf(incident) {
    return INCIDENT_KINDS.includes(incident?.kind) ? incident.kind : 'breach';
}

export function matchesSection(incident, sectionId) {
    return kindsOfSection(sectionId).includes(kindOf(incident));
}

export const CLOCK_STAGES = Object.freeze(['early_warning', 'notification', 'final_report', 'customer_notice']);

export const CRA_WINDOWS = Object.freeze({
    early_warning: 24 * HOUR_MS,
    notification: 72 * HOUR_MS,
    final_report: 14 * DAY_MS,
});

export const URGENT_BELOW = Object.freeze({
    breach: 24 * HOUR_MS,          // GDPR Art. 33 / NIS2 Art. 23 — last day
    cra_early_warning: 6 * HOUR_MS, // CRA Art. 14(2) — a quarter of the window
    cra_later: 24 * HOUR_MS,
});

const CLOSED = new Set(['closed']);

export function startedAtOf(incident) {
    return incident?.detected_at ?? incident?.created_at ?? null;
}

function addMs(iso, ms) {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isNaN(t) ? null : new Date(t + ms).toISOString();
}

/**
 * Every clock the row carries, in reporting order. Each:
 *   { stage, dueAt, sentAt, urgentBelowMs, labelKey, fallback, derived }
 * `dueAt` null → the regime does not carry that stage; `sentAt` set → done.
 * A closed incident marks every open stage done at `closed_at ?? updated_at`.
 */
export function clocksOf(incident) {
    if (!incident) return [];
    const vuln = isVulnerability(incident);
    const started = startedAtOf(incident);
    const closedAt = CLOSED.has(incident.status) ? (incident.closed_at ?? incident.updated_at ?? null) : null;
    const done = (sentAt) => sentAt ?? closedAt ?? null;

    const stages = [];
    const early = incident.early_warning_due_at ?? (vuln ? addMs(started, CRA_WINDOWS.early_warning) : null);
    if (early) {
        stages.push({
            stage: 'early_warning', dueAt: early, sentAt: done(incident.early_warning_sent_at),
            urgentBelowMs: vuln ? URGENT_BELOW.cra_early_warning : URGENT_BELOW.breach,
            labelKey: 'compliance.inc_clock_early_warning', fallback: 'Early warning (24 h)',
            derived: !incident.early_warning_due_at,
        });
    }
    const notification = incident.notification_due_at ?? incident.deadline_at ?? (vuln ? addMs(started, CRA_WINDOWS.notification) : null);
    if (notification) {
        stages.push({
            stage: 'notification', dueAt: notification,
            sentAt: done(incident.notification_sent_at ?? incident.authority_notified_at ?? incident.reported_at ?? null),
            urgentBelowMs: vuln ? URGENT_BELOW.cra_later : URGENT_BELOW.breach,
            labelKey: vuln ? 'compliance.vuln_clock_notification' : 'compliance.inc_clock_notification',
            fallback: vuln ? 'Vulnerability notification (72 h)' : 'Authority notification (72 h)',
            derived: !incident.notification_due_at && !incident.deadline_at,
        });
    }
    const final = incident.final_report_due_at ?? (vuln ? addMs(started, CRA_WINDOWS.final_report) : null);
    if (final) {
        stages.push({
            stage: 'final_report', dueAt: final, sentAt: done(incident.final_report_sent_at),
            urgentBelowMs: URGENT_BELOW.cra_later,
            labelKey: vuln ? 'compliance.vuln_clock_final_report' : 'compliance.inc_clock_final_report',
            fallback: vuln ? 'Final report (14 d)' : 'Final report (1 month)',
            derived: !incident.final_report_due_at,
        });
    }
    if (incident.customer_notice_due_at) {
        stages.push({
            stage: 'customer_notice', dueAt: incident.customer_notice_due_at, sentAt: done(incident.customer_notified_at),
            urgentBelowMs: URGENT_BELOW.breach,
            labelKey: 'compliance.inc_clock_customer_notice', fallback: 'Customer notice (DORA)',
            derived: false,
        });
    }
    return stages;
}

/** The clock the row is currently running: the earliest-due open stage; null when every stage is done or none exists. */
export function nextClock(incident) {
    const open = clocksOf(incident).filter(c => c.dueAt && !c.sentAt);
    if (!open.length) return null;
    return open.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
}

/** The most recent completion — what a done row shows ("completed in 2 days"). */
export function lastDone(incident) {
    const done = clocksOf(incident).filter(c => c.sentAt);
    if (!done.length) return null;
    return done.slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

/** The stage the "Report early warning" / "Report full" buttons submit next — CRA only. */
export function nextCraStage(incident) {
    if (!isVulnerability(incident)) return null;
    const next = nextClock(incident);
    return next && next.stage !== 'customer_notice' ? next.stage : null;
}

/** Status word → pill tone. */
export function toneOfIncidentStatus(status) {
    switch (status) {
        case 'open': return 'error';
        case 'assessing':
        case 'early_warning_sent': return 'warning';
        case 'closed': return 'success';
        default: return 'neutral'; // authority_notified, reported, subjects_notified
    }
}

export const STATUS_LABEL = Object.freeze({
    open: Object.freeze({ key: 'compliance.inc_status_open', en: 'Open' }),
    assessing: Object.freeze({ key: 'compliance.inc_status_assessing', en: 'Assessing' }),
    early_warning_sent: Object.freeze({ key: 'compliance.inc_status_early_warning_sent', en: 'Early warning sent' }),
    authority_notified: Object.freeze({ key: 'compliance.inc_status_authority', en: 'Authority notified' }),
    reported: Object.freeze({ key: 'compliance.inc_status_reported', en: 'Reported' }),
    subjects_notified: Object.freeze({ key: 'compliance.inc_status_subjects', en: 'Subjects notified' }),
    closed: Object.freeze({ key: 'compliance.inc_status_closed', en: 'Closed' }),
});

/** Parse "CVE-2026-1234, CVE-2026-999" (or newline-separated) into a deduped list of upper-cased ids. */
export function parseCveIds(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\s,;]+/)) {
        const id = raw.trim().toUpperCase();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/**
 * The create body — an explicit allow-list (BFSF-441): the register never
 * sends a field the form did not ask for. `kind` decides the regimes' default
 * on the server (CRA for a vulnerability, GDPR otherwise).
 */
export function createBodyOf(draft, kind) {
    const body = {
        kind,
        title: String(draft.title || '').trim(),
        description: String(draft.description || '').trim() || undefined,
        severity: draft.severity || 'medium',
        occurred_at: draft.occurred_at || undefined,
    };
    if (kind === 'vulnerability') {
        body.cve_ids = parseCveIds(draft.cve_ids);
        body.exploited_in_wild = !!draft.exploited_in_wild;
        const products = String(draft.affected_products || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean)
            .map(line => { const [name, ...rest] = line.split(/\s+/); return { name, version_range: rest.join(' ') || undefined }; });
        if (products.length) body.affected_products = products;
    } else {
        body.high_risk = !!draft.high_risk;
    }
    return body;
}
