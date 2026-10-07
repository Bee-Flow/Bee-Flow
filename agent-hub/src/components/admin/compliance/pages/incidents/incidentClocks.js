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
 *   { stage, dueAt, sentAt, notFiled, urgentBelowMs, labelKey, fallback, derived }
 * `dueAt` null → the regime does not carry that stage; `sentAt` is the real
 * filing stamp. On a closed incident a stage without a stamp is `notFiled`:
 * its clock stops (it is not running, and not overdue), but it does NOT count
 * as filed. A breach closed as "unlikely to result in a risk" (Art. 33(1))
 * was deliberately not notified, and reads so, never as "overdue by 217 h".
 */
export function clocksOf(incident) {
    if (!incident) return [];
    const vuln = isVulnerability(incident);
    const started = startedAtOf(incident);
    const closed = CLOSED.has(incident.status);
    const done = (sentAt) => sentAt ?? null;

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
    return stages.map(c => ({ ...c, notFiled: closed && !c.sentAt }));
}

/** The clock the row is currently running: the earliest-due open stage; null when every stage is filed, closed or none exists. */
export function nextClock(incident) {
    const open = clocksOf(incident).filter(c => c.dueAt && !c.sentAt && !c.notFiled);
    if (!open.length) return null;
    return open.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
}

/** The most recent filing — what a done row shows ("completed in 2 days"). */
export function lastDone(incident) {
    const done = clocksOf(incident).filter(c => c.sentAt);
    if (!done.length) return null;
    return done.slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

/**
 * A closed incident none of whose stages was filed: the row reads
 * "closed · not notified" in quiet ink instead of a clock.
 */
export function isClosedUnfiled(incident) {
    if (!incident || !CLOSED.has(incident.status)) return false;
    const clocks = clocksOf(incident);
    return clocks.length > 0 && clocks.every(c => c.notFiled);
}

/** Filed stages out of all stages: the row's "{n} of {total} filed". */
export function filedCount(incident) {
    const clocks = clocksOf(incident);
    return { filed: clocks.filter(c => c.sentAt).length, total: clocks.length };
}

/**
 * The drawer's "Reporting" list: every regulatory stage (clocksOf) plus the
 * stamps that have no clock of their own, in reporting order: the internal
 * recipients e-mail first, then the stages, then the Art. 34 notice to the
 * data subjects (a high-risk breach) or the CRA customer notice (a
 * vulnerability without a DORA clock). Each row:
 *   { id, labelKey, fallback, dueAt|null, filedAt|null, notFiled, via|null, reference|null }
 */
export function reportingRowsOf(incident) {
    if (!incident) return [];
    const vuln = isVulnerability(incident);
    const closed = CLOSED.has(incident.status);
    const clocks = clocksOf(incident);
    const stamp = (id, labelKey, fallback, filedAt) => ({ id, labelKey, fallback, dueAt: null, filedAt: filedAt ?? null, notFiled: closed && !filedAt, via: null, reference: null });
    const rows = clocks.map(c => ({
        id: c.stage, labelKey: c.labelKey, fallback: c.fallback, dueAt: c.dueAt, filedAt: c.sentAt, notFiled: c.notFiled,
        via: vuln && c.stage === 'early_warning' ? incident.reported_via ?? null : null,
        reference: c.stage === 'notification' ? incident.authority_reference ?? null : null,
    }));
    if (vuln) {
        if (!clocks.some(c => c.stage === 'customer_notice')) rows.push(stamp('customers', 'compliance.vuln_stamp_customers', 'Customers notified', incident.customer_notified_at));
        return rows;
    }
    rows.unshift(stamp('recipients', 'compliance.inc_stamp_recipients', 'Internal recipients', incident.recipients_notified_at));
    if (incident.high_risk) rows.push(stamp('subjects', 'compliance.inc_stamp_subjects', 'Data subjects (Art. 34)', incident.subjects_notified_at));
    return rows;
}

/**
 * The filing steps the drawer offers, as `{ primary, others }`:
 *   authority          record the authority notification (GDPR Art. 33 / NIS2)
 *   cra_early_warning · cra_notification · cra_final_report
 *                      report the next CRA Art. 14 stage (a vulnerability)
 *   customers          stamp the customer notice (DORA, or CRA users)
 *   subjects           record the Art. 34 notice to the data subjects
 * `primary` is the step of the stage whose clock runs (nextClock); a stage
 * without a step of its own here (a NIS2 early warning on a non-CRA row)
 * falls back to the first step left. A closed incident has none.
 */
export function stepsOf(incident) {
    if (!incident || CLOSED.has(incident.status)) return { primary: null, others: [] };
    const steps = [];
    if (isVulnerability(incident)) {
        const cra = nextCraStage(incident);
        if (cra) steps.push(`cra_${cra}`);
        if (!incident.customer_notified_at) steps.push('customers');
    } else {
        if (!incident.authority_notified_at) steps.push('authority');
        if (incident.customer_notice_due_at && !incident.customer_notified_at) steps.push('customers');
        if (incident.high_risk && !incident.subjects_notified_at) steps.push('subjects');
    }
    const next = nextClock(incident);
    let primary = null;
    if (next?.stage === 'customer_notice') primary = steps.includes('customers') ? 'customers' : null;
    else if (next) primary = steps.find(s => s === 'authority' || s.startsWith('cra_')) ?? null;
    primary = primary ?? steps[0] ?? null;
    return { primary, others: steps.filter(s => s !== primary) };
}

/** The stage the "Report early warning" / "Report full" buttons submit next — CRA only. */
export function nextCraStage(incident) {
    if (!isVulnerability(incident)) return null;
    const next = nextClock(incident);
    return next && next.stage !== 'customer_notice' ? next.stage : null;
}

/** Status word → its label. How the pill looks is statusVocabulary's (RegisterStatePill), as on every register. */
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

/** Now (or `ms`) as a datetime-local value in the reader's own clock: 'YYYY-MM-DDTHH:mm' (localToIso's inverse). */
export function localInputValue(ms = Date.now()) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value ('2026-10-05T14:30', the reader's own clock) as an ISO instant; undefined when blank or unreadable. */
export function localToIso(value) {
    if (!value) return undefined;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * The create body — an explicit allow-list (BFSF-441): the register never
 * sends a field the form did not ask for. `kind` decides the regimes' default
 * on the server (CRA for a vulnerability, GDPR otherwise). `detected_at` is
 * when the organisation became aware: the 72-hour clock runs from there, not
 * from the moment someone filled in the form.
 */
export function createBodyOf(draft, kind) {
    const body = {
        kind,
        title: String(draft.title || '').trim(),
        description: String(draft.description || '').trim() || undefined,
        severity: draft.severity || 'medium',
        // Both moments come from datetime-local inputs (the reader's clock):
        // sent as instants, so the server never reads them in its own zone.
        occurred_at: localToIso(draft.occurred_at),
        detected_at: localToIso(draft.detected_at),
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
