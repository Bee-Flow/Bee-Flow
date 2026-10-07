/**
 * The Compliance demo's incident register, as incidentStore keeps it.
 *
 * The clocks follow the store's REGIME_CLOCKS (stores/incidentClocks.js): GDPR
 * a 72 h notification; NIS2 a 24 h early warning, the 72 h notification and a
 * final report one calendar month in; CRA 24 h, 72 h and a final report 14
 * days in for a vulnerability (Art. 14(2)(c)) or one calendar month after the
 * notification for a severe incident (Art. 14(4)(c), counted from detected +
 * 72 h until the notification is stamped); DORA the customer notice within
 * the hours the settings name (4 h here). A month is a calendar month,
 * clamped to the end of a short month (addCalendarMonths), as the server
 * counts it. `deadline_at` is what the store keeps (nextOpenDeadline): the
 * EARLIEST clock still open, null once every clock is met or the incident is
 * closed. The notification has no column; clients derive it from detected_at.
 * Ids are numbers (a SERIAL column), the log is [{ at, by, text }], and every
 * write moves updated_at and the deadline, as the store's mutators do.
 * Computed, so the countdowns on screen are real.
 */

import { addCalendarMonths } from '../../components/shared/deadlineMath';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DORA_CUSTOMER_NOTICE_HOURS = 4;
const ACTOR = 'u_marieke';

/** incidentStore OPEN_STATUSES: nothing has gone to an authority yet (getDeadlineStats "open"). */
export const INCIDENT_OPEN_STATUSES = Object.freeze(['open', 'assessing', 'early_warning_sent']);
const KINDS = Object.freeze(['breach', 'security_incident', 'vulnerability']);

type Regime = 'GDPR' | 'NIS2' | 'CRA' | 'DORA';
type RegimeClock = {
    earlyWarningHours?: number;
    notificationHours?: number;
    finalDays?: number;
    finalMonths?: number;
    /** CRA severe incident (Art. 14(4)(c)): months after the notification. */
    incidentFinalMonths?: number;
    customerNotice?: boolean;
};
const REGIME_CLOCKS: Readonly<Record<Regime, RegimeClock>> = {
    GDPR: { notificationHours: 72 },
    NIS2: { earlyWarningHours: 24, notificationHours: 72, finalMonths: 1 },
    CRA: { earlyWarningHours: 24, notificationHours: 72, finalDays: 14, incidentFinalMonths: 1 },
    DORA: { customerNotice: true },
};

/** incidentClocks._isCraSevereIncident: a CRA row that is not a vulnerability. */
const isCraSevereIncident = (kind: string | null | undefined, regimes: readonly string[]) =>
    !!kind && kind !== 'vulnerability' && regimes.includes('CRA');

const monthsLater = (from: string | number, months: number) => new Date(addCalendarMonths(from, months) as number).toISOString();

export interface IncidentNote { at: string; by: string | null; text: string }

export interface Incident {
    id: number;
    organization_id: string;
    kind: string;
    regimes: string[];
    title: string;
    description: string;
    severity: string;
    high_risk: boolean;
    status: string;
    source: string;
    detected_at: string;
    occurred_at: string | null;
    deadline_at: string | null;
    early_warning_due_at: string | null;
    early_warning_sent_at: string | null;
    final_report_due_at: string | null;
    final_report_sent_at: string | null;
    customer_notice_due_at: string | null;
    customer_notified_at: string | null;
    recipients_notified_at: string | null;
    authority_notified_at: string | null;
    authority_reference: string | null;
    authority_notified_by: string | null;
    subjects_notified_at: string | null;
    subjects_notified_by: string | null;
    reported_via: string | null;
    cve_ids: string[];
    affected_products: string[];
    exploited_in_wild: boolean | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    notes: IncidentNote[];
}

type Seed = Partial<Incident> & Pick<Incident, 'id' | 'title' | 'detected_at'>;
type State = { incidents: Incident[]; frameworks: { enabled: string[] } };
type Body = Record<string, unknown> | null;
type Ctx = { state: State; params: { id: string }; body: Body };

export interface IncidentRouteDeps {
    org: string;
    /** Re-derive the evidence chain after a write. */
    reseal: (state: State) => void;
    /** The demo's 4xx body: `{ error, ...extra }`. */
    refuse: (error: string, status?: number, extra?: Record<string, unknown>) => Response;
}

const earliest = (dates: (string | null | undefined)[]): string | null => {
    const ts = dates.filter((d): d is string => !!d).map(d => new Date(d).getTime());
    return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
};

/**
 * incidentClocks.computeClocks: each stage's earliest due date over the row's
 * regimes. `kind` splits the CRA final report: a vulnerability's runs 14 days,
 * a severe incident's one calendar month after the notification — from
 * `notifiedAt` when recorded, else from the latest lawful notification
 * (detected + 72 h).
 */
export function computeClocks(detectedAt: string, regimes: readonly string[], kind?: string | null, notifiedAt?: string | null) {
    const t = new Date(detectedAt).getTime();
    const at = (ms: number) => new Date(t + ms).toISOString();
    const severeCra = isCraSevereIncident(kind, regimes);
    const early: string[] = [];
    const notification: string[] = [];
    const finals: string[] = [];
    let customer: string | null = null;
    for (const code of regimes) {
        const c = REGIME_CLOCKS[code as Regime] || {};
        if (c.earlyWarningHours) early.push(at(c.earlyWarningHours * HOUR_MS));
        if (c.notificationHours) notification.push(at(c.notificationHours * HOUR_MS));
        if (code === 'CRA' && severeCra && c.incidentFinalMonths && c.notificationHours) {
            const from = notifiedAt && Number.isFinite(new Date(notifiedAt).getTime())
                ? notifiedAt
                : t + c.notificationHours * HOUR_MS;
            finals.push(monthsLater(from, c.incidentFinalMonths));
        } else if (c.finalDays) {
            finals.push(at(c.finalDays * DAY_MS));
        } else if (c.finalMonths) {
            finals.push(monthsLater(t, c.finalMonths));
        }
        if (c.customerNotice) customer = at(DORA_CUSTOMER_NOTICE_HOURS * HOUR_MS);
    }
    return {
        early_warning_due_at: earliest(early), notification_due_at: earliest(notification),
        final_report_due_at: earliest(finals), customer_notice_due_at: customer,
    };
}

/** The clock columns openDeadline reads; the deadline feed passes a row narrowed to some regimes. */
type ClockRow = Pick<Incident, 'status' | 'kind' | 'regimes' | 'detected_at' | 'authority_notified_at'
    | 'early_warning_due_at' | 'early_warning_sent_at' | 'customer_notice_due_at' | 'customer_notified_at'
    | 'final_report_due_at' | 'final_report_sent_at'>;

/**
 * incidentClocks.nextOpenDeadline: the earliest clock whose stamp is missing;
 * null when closed or all met. A stored `*_due_at` column wins over the
 * recomputation (the customer notice is the only record of the org's DORA
 * window); a cleared one is recomputed from the row's regimes.
 */
export function openDeadline(row: ClockRow): string | null {
    if (row.status === 'closed') return null;
    const c = computeClocks(row.detected_at, regimesFor(row.kind, row.regimes), row.kind, row.authority_notified_at);
    return earliest([
        row.early_warning_sent_at ? null : (row.early_warning_due_at || c.early_warning_due_at),
        row.authority_notified_at ? null : c.notification_due_at,
        row.customer_notified_at ? null : (row.customer_notice_due_at || c.customer_notice_due_at),
        row.final_report_sent_at ? null : (row.final_report_due_at || c.final_report_due_at),
    ]);
}

/**
 * incidentClocks._severeIncidentFinalDue: a CRA severe incident's final report
 * runs from the notification, which is stamped after creation, so it moves
 * with the row until the report is filed. Null for every other row.
 */
function severeIncidentFinalDue(row: Incident): string | null {
    if (row.final_report_sent_at || row.status === 'closed') return null;
    if (!isCraSevereIncident(row.kind, row.regimes)) return null;
    return computeClocks(row.detected_at, row.regimes, row.kind, row.authority_notified_at).final_report_due_at;
}

/** A row after a write: the store's _refreshDeadline (the severe-incident final report first). */
const refreshed = (row: Incident): Incident => {
    const finalDue = severeIncidentFinalDue(row);
    const next = finalDue && finalDue !== row.final_report_due_at ? { ...row, final_report_due_at: finalDue } : row;
    return { ...next, deadline_at: openDeadline(next) };
};

/** incidentStore.normalizeRegimes: none given is a CRA matter for a vulnerability and a GDPR one otherwise. */
function regimesFor(kind: string | null | undefined, regimes: unknown): string[] {
    return Array.isArray(regimes) && regimes.length
        ? regimes.map(String)
        : [kind === 'vulnerability' ? 'CRA' : 'GDPR'];
}

/** A stored row: the store's defaults, the clock columns of its regimes, and its deadline. */
export function incidentRow(org: string, o: Seed): Incident {
    const kind = o.kind || 'breach';
    const regimes = regimesFor(kind, o.regimes);
    const c = computeClocks(o.detected_at, regimes, kind, o.authority_notified_at);
    return refreshed({
        organization_id: org, kind, source: 'manual', severity: 'medium', high_risk: false, status: 'open',
        description: '', occurred_at: null, deadline_at: null,
        recipients_notified_at: null, authority_notified_at: null, authority_reference: null, authority_notified_by: null,
        subjects_notified_at: null, subjects_notified_by: null,
        early_warning_sent_at: null, final_report_sent_at: null, customer_notified_at: null,
        cve_ids: [], affected_products: [], exploited_in_wild: null, reported_via: null,
        created_by: ACTOR, created_at: o.detected_at, updated_at: o.detected_at,
        notes: [],
        ...o,
        regimes,
        early_warning_due_at: c.early_warning_due_at,
        final_report_due_at: c.final_report_due_at,
        customer_notice_due_at: c.customer_notice_due_at,
    });
}

/** The four incidents of the fictional office, newest first. */
export function incidentSeed(org: string, now: number = Date.now()): Incident[] {
    const ago = (ms: number) => new Date(now - ms).toISOString();
    return [
        // An ICT incident that reaches the insurers this office works for: under
        // DORA the provider tells its financial customers inside the window the
        // contract names, and the register carries that clock beside the GDPR one.
        incidentRow(org, {
            id: 32, kind: 'security_incident', regimes: ['GDPR', 'DORA'],
            title: 'Policy-system connector down for 3 hours after a token rotation',
            description: 'An expired credential stopped the nightly sync with two insurers. No data was exposed; the backlog was replayed. Reported here because the outage touches services two financial entities depend on.',
            detected_at: ago(3 * HOUR_MS), occurred_at: ago(6 * HOUR_MS), created_by: 'u_farah', updated_at: ago(2 * HOUR_MS),
            notes: [{ at: ago(2 * HOUR_MS), by: 'u_farah', text: 'Credential rotated and the sync replayed. Customer notification still to be stamped.' }],
        }),
        incidentRow(org, {
            id: 31, title: 'Claim summary emailed to the wrong broker',
            description: 'An assistant-drafted summary was sent to a broker address from a different policy. One data subject affected; content included name, policy number and a description of the damage.',
            detected_at: ago(19 * HOUR_MS), occurred_at: ago(26 * HOUR_MS), status: 'assessing',
            recipients_notified_at: ago(18 * HOUR_MS), updated_at: ago(17 * HOUR_MS),
            notes: [{ at: ago(17 * HOUR_MS), by: ACTOR, text: 'Recipient confirmed deletion in writing. Assessing whether Art. 33 notification is required.' }],
        }),
        incidentRow(org, {
            id: 30, title: 'Shared mailbox credential found in a support ticket',
            description: 'A password for a shared claims mailbox was pasted into a ticket body by a member. Rotated within the hour; access logs show no use from an unknown address.',
            severity: 'high', detected_at: ago(12 * DAY_MS), occurred_at: ago(12 * DAY_MS + 3 * HOUR_MS), status: 'closed',
            recipients_notified_at: ago(12 * DAY_MS - HOUR_MS), updated_at: ago(11 * DAY_MS),
            // The Art. 33(5) reason a breach was closed without notifying.
            notes: [{ at: ago(11 * DAY_MS), by: ACTOR, text: 'Assessed as unlikely to result in a risk (Art. 33(1)); documented rather than notified. Credential rotated, mailbox access reviewed.' }],
        }),
        incidentRow(org, {
            id: 29, title: 'Misconfigured export exposed a claims folder',
            description: 'A document export ran with the wrong scope and wrote 214 claim files to a folder readable by all staff for 4 days.',
            severity: 'high', high_risk: true, detected_at: ago(63 * DAY_MS), occurred_at: ago(67 * DAY_MS), status: 'closed',
            authority_notified_at: ago(62 * DAY_MS), authority_reference: 'AP-2026-0043118', authority_notified_by: ACTOR,
            subjects_notified_at: ago(59 * DAY_MS), subjects_notified_by: ACTOR, recipients_notified_at: ago(63 * DAY_MS),
            updated_at: ago(55 * DAY_MS),
            notes: [
                { at: ago(62 * DAY_MS), by: ACTOR, text: 'Notified to the Autoriteit Persoonsgegevens within 41 hours.' },
                { at: ago(55 * DAY_MS), by: ACTOR, text: 'Affected policyholders informed by post; export scope fixed and access reviewed.' },
            ],
        }),
    ];
}

const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const nextId = (rows: readonly Incident[]) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const find = (state: State, id: string) => state.incidents.find(x => String(x.id) === id) || null;

/** What POST /incidents stores from the form, with the store's defaults. */
function createdFields(body: Record<string, unknown>): Omit<Seed, 'id'> {
    const at = new Date().toISOString();
    const exploited = body.exploited_in_wild ?? body.actively_exploited;
    return {
        title: text(body.title, 'Untitled incident'), description: text(body.description, ''),
        severity: text(body.severity, 'medium'), high_risk: body.high_risk === true,
        detected_at: text(body.detected_at, at), occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : null,
        created_by: ACTOR, created_at: at, updated_at: at,
        cve_ids: list(body.cve_ids), affected_products: list(body.affected_products),
        exploited_in_wild: typeof exploited === 'boolean' ? exploited : null,
    };
}

/** A text the form sent, cut to the column's length, or null for none. */
const given = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/**
 * incidentStore.stampCraReport: the timestamps are first-wins; the channel and
 * the reference are COALESCE(new, old), so a value the form sends replaces the
 * earlier one.
 */
function craStamp(i: Incident, stage: 'early_warning' | 'full', body: Body, at: string): Partial<Incident> {
    const reported_via = given(body?.reported_via, 100) ?? i.reported_via;
    if (stage === 'early_warning') {
        return { early_warning_sent_at: i.early_warning_sent_at || at, reported_via, status: ['open', 'assessing'].includes(i.status) ? 'early_warning_sent' : i.status };
    }
    return {
        final_report_sent_at: i.final_report_sent_at || at,
        authority_notified_at: i.authority_notified_at || at,
        authority_reference: given(body?.reference, 200) ?? i.authority_reference,
        reported_via,
        status: INCIDENT_OPEN_STATUSES.includes(i.status) ? 'reported' : i.status,
    };
}

/** incidentStore.updateIncident: a status stamps its column once, a note joins the log. */
function patched(i: Incident, body: Body, at: string): Incident {
    const { note, ...patch } = (body || {}) as Record<string, unknown> & { note?: unknown };
    const notifying = patch.status === 'authority_notified';
    const informing = patch.status === 'subjects_notified';
    return refreshed({
        ...i, ...(patch as Partial<Incident>), updated_at: at,
        authority_notified_at: notifying ? (i.authority_notified_at || at) : i.authority_notified_at,
        authority_notified_by: notifying ? (i.authority_notified_by || ACTOR) : i.authority_notified_by,
        subjects_notified_at: informing ? (i.subjects_notified_at || at) : i.subjects_notified_at,
        subjects_notified_by: informing ? (i.subjects_notified_by || ACTOR) : i.subjects_notified_by,
        notes: note ? [...i.notes, { at, by: ACTOR, text: String(note).slice(0, 2000) }] : i.notes,
    });
}

export function incidentRoutes({ org, reseal, refuse }: IncidentRouteDeps) {
    const replace = (state: State, next: Incident) => {
        state.incidents = state.incidents.map(x => (x.id === next.id ? next : x));
        reseal(state);
        return next;
    };
    return {
        'GET /api/compliance/incidents': ({ state, query }: Ctx & { query: URLSearchParams }) => {
            const kind = query.get('kind');
            const status = query.get('status');
            return state.incidents.filter(i => (!kind || i.kind === kind) && (!status || i.status === status));
        },
        'POST /api/compliance/incidents': ({ state, body }: Ctx) => {
            const kind = KINDS.includes(body?.kind as string) ? String(body?.kind) : 'breach';
            const regimes = regimesFor(kind, body?.regimes);
            // The CRA register only exists for an org that switched the CRA on —
            // the server refuses the row rather than storing an orphan.
            if ((kind === 'vulnerability' || regimes.includes('CRA')) && !state.frameworks.enabled.includes('cra')) {
                return refuse('framework_disabled', 409, { regulation: 'CRA', framework: 'cra' });
            }
            const created = incidentRow(org, { ...createdFields(body || {}), id: nextId(state.incidents), kind, regimes });
            state.incidents = [created, ...state.incidents];
            reseal(state);
            return created;
        },
        // CRA Art. 14: the early warning moves an open row to early_warning_sent;
        // `full` stamps the final report AND the notification and moves it to reported.
        'POST /api/compliance/incidents/:id/cra-report': ({ state, params, body }: Ctx) => {
            const stage = body?.stage;
            if (stage !== 'early_warning' && stage !== 'full') return refuse('invalid_stage');
            const i = find(state, params.id);
            if (!i) return refuse('not_found', 404);
            if (i.kind !== 'vulnerability' && !i.regimes.includes('CRA')) return refuse('not_cra_incident', 409);
            const at = new Date().toISOString();
            return replace(state, refreshed({
                ...i, ...craStamp(i, stage, body, at), updated_at: at,
                authority_notified_by: i.authority_notified_by || ACTOR,
            }));
        },
        // DORA: the financial customers have been told (stampCustomerNotified).
        'POST /api/compliance/incidents/:id/customer-notified': ({ state, params }: Ctx) => {
            const i = find(state, params.id);
            if (!i) return refuse('not_found', 404);
            const at = new Date().toISOString();
            return replace(state, refreshed({
                ...i, customer_notified_at: i.customer_notified_at || at, updated_at: at,
                notes: [...i.notes, { at, by: ACTOR, text: 'Customer notice sent' }],
            }));
        },
        'PATCH /api/compliance/incidents/:id': ({ state, params, body }: Ctx) => {
            const i = find(state, params.id);
            if (!i) return refuse('not_found', 404);
            return replace(state, patched(i, body, new Date().toISOString()));
        },
        'POST /api/compliance/incidents/:id/notify-recipients': ({ state, params }: Ctx) => {
            const i = find(state, params.id);
            if (i) {
                const at = new Date().toISOString();
                state.incidents = state.incidents.map(x => (x.id === i.id ? { ...x, recipients_notified_at: at, updated_at: at } : x));
            }
            // Nothing is sent from a demo, and saying so beats a silent success.
            return { notified: 0, demo_not_sent: true };
        },
    };
}
