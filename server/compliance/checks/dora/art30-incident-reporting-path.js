/**
 * DORA Art. 30(2)(f), 30(3)(c) — the incident reporting path towards
 * financial customers (Art. 19 sets THEIR clocks: initial notification within
 * 4 h of classification / 24 h of detection).
 *
 * A financial entity can only meet its own Art. 19 deadlines when its ICT
 * provider tells it about a major incident promptly. Two things must be true
 * here, one static and one live:
 *
 *   READINESS — `incident_customer_contacts` (JSONB [{name, email, entity}])
 *               holds at least one contact, and a notice window
 *               (`dora_customer_notice_hours`, default 4) is set.
 *   CLOCKS    — every open incident with 'DORA' in `regimes` is notified to
 *               the customers (`customer_notified_at`) before its
 *               `customer_notice_due_at` (the store sets it when the incident
 *               is filed; older rows fall back to detected_at + window).
 *
 *   no customer contact                              → fail
 *   an open DORA incident past its window, unstamped → fail
 *   a window closing within 1 h, or no entity named  → warn
 *   otherwise                                        → pass
 *
 * Incident rows come from incidentStore.listOpenClocks(orgId) when the store
 * provides it (guarded), else from our own SELECT. Missing columns/tables →
 * warn "not provisioned yet" — a fresh install never crashes the sweep.
 *
 * Relevance: `framework_relevance.dora` 'not_relevant' → not_applicable;
 * 'unknown' (or unset) → the check runs and says the Frameworks card asks.
 *
 * The platform never notifies a customer by itself — the stamp is an
 * attestation, the clock is automated. Evidence carries counts, incident ids
 * and timestamps only: never a contact's name or e-mail address, never the
 * incident text (BFSF-441).
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');

const HOUR = 3600 * 1000;
const DEFAULT_NOTICE_HOURS = 4;
const URGENT_HOURS = 1;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    const v = rel && typeof rel === 'object' ? rel.dora : undefined;
    return v === 'not_relevant' || v === 'relevant' ? v : 'unknown';
}

function _asArray(value) {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return Array.isArray(v) ? v : [];
}

/** A usable contact has at least a route to reach it (an e-mail address). */
function _contacts(settings) {
    const list = _asArray(settings.incident_customer_contacts);
    const usable = list.filter(c => c && typeof c === 'object' && typeof c.email === 'string' && /@/.test(c.email));
    const entities = new Set(usable.map(c => typeof c.entity === 'string' ? c.entity.trim() : '').filter(Boolean));
    return { total: list.length, usable: usable.length, entities: entities.size };
}

function _noticeHours(settings) {
    const n = Number(settings.dora_customer_notice_hours);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_NOTICE_HOURS;
}

function _regimes(row) {
    let r = row && row.regimes;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
    return Array.isArray(r) ? r : null;
}

function _isDora(row) {
    const regimes = _regimes(row);
    // A helper that already filtered on regime may omit the column — keep those rows.
    return regimes === null ? true : regimes.includes('DORA');
}

async function _openDoraIncidents(orgId) {
    const fn = incidentStore.listOpenClocks;
    if (typeof fn === 'function') {
        try {
            const rows = await fn.call(incidentStore, orgId);
            if (Array.isArray(rows)) {
                return { rows: rows.filter(r => r && r.status !== 'closed' && _isDora(r)), source: 'incidentStore.listOpenClocks' };
            }
        } catch (e) {
            if (!NOT_PROVISIONED.has(e?.code)) throw e;
            return { rows: null, source: 'incidentStore.listOpenClocks', missing: e.code };
        }
    }
    try {
        const rows = await getAll(`
            SELECT id, kind, status, severity, detected_at, customer_notice_due_at, customer_notified_at
            FROM compliance_incidents
            WHERE organization_id = $1
              AND status <> 'closed'
              AND COALESCE(regimes, '[]'::jsonb) @> '["DORA"]'::jsonb
            ORDER BY detected_at DESC
            LIMIT 50
        `, [orgId]);
        return { rows, source: 'query' };
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return { rows: null, source: 'query', missing: e.code };
        throw e;
    }
}

/**
 * The store's own `customer_notice_due_at` (set when the incident was filed)
 * wins; without it the clock is detected_at + the org's current notice window.
 */
function _clock(dueAtStored, detectedAt, notifiedAt, noticeHours, now) {
    const notified = notifiedAt ? new Date(notifiedAt).toISOString() : null;
    let due = dueAtStored ? new Date(dueAtStored).getTime() : NaN;
    if (!Number.isFinite(due)) {
        const detected = detectedAt ? new Date(detectedAt).getTime() : NaN;
        if (!Number.isFinite(detected)) return { due_at: null, notified_at: notified, state: notified ? 'notified' : 'no_clock' };
        due = detected + noticeHours * HOUR;
    }
    const dueIso = new Date(due).toISOString();
    if (notified) return { due_at: dueIso, notified_at: notified, state: 'notified' };
    if (due < now) return { due_at: dueIso, notified_at: null, state: 'overdue' };
    if (due - now <= URGENT_HOURS * HOUR) return { due_at: dueIso, notified_at: null, state: 'urgent' };
    return { due_at: dueIso, notified_at: null, state: 'running' };
}

module.exports = {
    id: 'DORA-Art30-incident-reporting-path',
    regulation: 'DORA',
    article: 'Art. 30(2)(f)',
    frameworks: [
        { regulation: 'NIS2', ref: 'Art. 23' },
        { regulation: 'GDPR', ref: 'Art. 33' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_dora_incident_path_title',
    descriptionKey: 'compliance.check_dora_incident_path_desc',
    remediationKey: 'compliance.check_dora_incident_path_fix',
    remediationLink: 'admin/compliance/incidents',

    async evaluate(orgId) {
        const settings = (await complianceStore.getSettings(orgId)) || {};
        const relevance = _relevance(settings);
        if (relevance === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'DORA is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }
        const relevanceNote = relevance === 'unknown'
            ? ' DORA relevance is still unanswered — the Frameworks card asks whether you provide ICT services to financial entities.'
            : '';

        const contacts = _contacts(settings);
        const noticeHours = _noticeHours(settings);
        const readiness = {
            relevance,
            contacts_count: contacts.usable,
            contacts_declared: contacts.total,
            financial_entities_count: contacts.entities,
            notice_hours: noticeHours,
            notice_hours_default: settings.dora_customer_notice_hours == null,
        };

        const { rows, source, missing } = await _openDoraIncidents(orgId);
        if (rows === null) {
            return {
                status: 'warn',
                evidence: { ...readiness, register_provisioned: false, missing, source },
                details: 'not provisioned yet — the incident register has no DORA columns (regimes, customer_notified_at), so the customer-notice clock cannot be tracked.' + relevanceNote,
            };
        }

        const now = Date.now();
        const incidents = rows.map(r => ({
            id: r.id,
            kind: r.kind || null,
            status: r.status,
            severity: r.severity || null,
            detected_at: r.detected_at ? new Date(r.detected_at).toISOString() : null,
            clock: _clock(r.customer_notice_due_at, r.detected_at, r.customer_notified_at, noticeHours, now),
        }));
        const overdue = incidents.filter(i => i.clock.state === 'overdue');
        const urgent = incidents.filter(i => i.clock.state === 'urgent');
        const notified = incidents.filter(i => i.clock.state === 'notified');

        const evidence = {
            ...readiness,
            register_provisioned: true,
            source,
            open_dora_incidents: incidents.length,
            overdue_count: overdue.length,
            urgent_count: urgent.length,
            notified_count: notified.length,
            urgent_window_hours: URGENT_HOURS,
            incidents: incidents.slice(0, 10),
        };

        if (contacts.usable === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'No customer incident contact is configured, so a major ICT incident cannot be reported to the financial entities you serve — add at least one contact (entity, name, e-mail) under Compliance → Settings → DORA.'
                    + (overdue.length ? ` ${overdue.length} open DORA incident(s) are already past the ${noticeHours} h notice window.` : '')
                    + relevanceNote,
            };
        }
        if (overdue.length) {
            return {
                status: 'fail',
                evidence,
                details: `${overdue.length} open DORA incident(s) passed the ${noticeHours} h customer-notice window without a recorded customer notification (ids ${overdue.map(i => i.id).join(', ')}). Notify the affected financial entities and stamp it on the incident, or close the incident with an assessment.` + relevanceNote,
            };
        }
        const warnings = [];
        if (urgent.length) warnings.push(`${urgent.length} open DORA incident(s) reach the ${noticeHours} h customer-notice window within ${URGENT_HOURS} hour.`);
        if (contacts.entities === 0) warnings.push(`${contacts.usable} customer contact(s) configured but none names the financial entity it belongs to — record the entity so the notification can be addressed per customer.`);
        if (warnings.length) {
            return { status: 'warn', evidence, details: warnings.join(' ') + relevanceNote };
        }
        return {
            status: 'pass',
            evidence,
            details: (incidents.length
                ? `Reporting path operational: ${contacts.usable} customer contact(s) across ${contacts.entities} financial entit${contacts.entities === 1 ? 'y' : 'ies'}, ${noticeHours} h notice window, ${incidents.length} open DORA incident(s) all notified or inside the window.`
                : `Reporting path ready: ${contacts.usable} customer contact(s) across ${contacts.entities} financial entit${contacts.entities === 1 ? 'y' : 'ies'}, ${noticeHours} h notice window, no open DORA incident.`)
                + relevanceNote,
        };
    },
};

module.exports._test = { DEFAULT_NOTICE_HOURS, URGENT_HOURS, _clock, _contacts };
