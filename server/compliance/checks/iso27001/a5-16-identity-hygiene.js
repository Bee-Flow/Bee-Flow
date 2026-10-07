/**
 * ISO 27001 A.5.16 — identity hygiene across the org's directories.
 * Reads the google-workspace and microsoft-entra connector summaries
 * (whichever are enabled) and judges the account population on two signals:
 * dormant accounts (no sign-in for 90 days) and MFA enrolment. Unknown
 * values — e.g. Graph report permissions not granted — degrade to warn,
 * never to a silent pass.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const { unreadableConnector } = require('../../lib/connectorEvidence');

const SOURCES = ['google-workspace', 'microsoft-entra'];
const DORMANT_FAIL_PCT = 10;
const DORMANT_WARN_PCT = 1;
const MFA_FAIL_PCT = 50;
const MFA_WARN_PCT = 90;

const RANK = { pass: 0, warn: 1, fail: 2 };

function _pct(part, whole) {
    return Math.round((part / whole) * 1000) / 10;
}

/** Judge one directory summary payload → { status, notes, metrics }. */
function _judgeSource(id, p) {
    const users = Number(p.users) || 0;
    const active = (p.enabled !== null && p.enabled !== undefined)
        ? Number(p.enabled) || 0
        : Math.max(0, users - (Number(p.suspended) || 0));
    const dormant = (p.dormant_90d === null || p.dormant_90d === undefined) ? null : Number(p.dormant_90d);
    const mfaRaw = (p.mfa_enrolled !== null && p.mfa_enrolled !== undefined) ? p.mfa_enrolled : p.mfa_capable;
    const mfa = (mfaRaw === null || mfaRaw === undefined) ? null : Number(mfaRaw);

    const notes = [];
    let status = 'pass';
    const bump = (level) => { if (RANK[level] > RANK[status]) status = level; };

    if (!active) {
        return {
            status: 'warn',
            notes: [`${id}: no active accounts in the snapshot — nothing to assess`],
            metrics: { source: id, users, active: 0, dormant_90d: dormant, dormant_pct: null, mfa, mfa_pct: null, admins: p.admins ?? null },
        };
    }

    const dormantPct = dormant === null ? null : _pct(dormant, active);
    if (dormantPct === null) {
        bump('warn');
        notes.push(`${id}: dormant-account data unavailable (sign-in activity permission not granted)`);
    } else if (dormantPct > DORMANT_FAIL_PCT) {
        bump('fail');
        notes.push(`${id}: ${dormant} of ${active} active accounts dormant for 90+ days (${dormantPct}%)`);
    } else if (dormantPct > DORMANT_WARN_PCT) {
        bump('warn');
        notes.push(`${id}: ${dormant} dormant account(s) (${dormantPct}% of ${active})`);
    }

    const mfaPct = mfa === null ? null : _pct(mfa, active);
    if (mfaPct === null) {
        bump('warn');
        notes.push(`${id}: MFA enrolment unknown (reporting permission or licence missing)`);
    } else if (mfaPct < MFA_FAIL_PCT) {
        bump('fail');
        notes.push(`${id}: only ${mfa} of ${active} active accounts MFA-enrolled (${mfaPct}%)`);
    } else if (mfaPct < MFA_WARN_PCT) {
        bump('warn');
        notes.push(`${id}: MFA enrolment at ${mfaPct}% (${mfa} of ${active}) — below the 90% bar`);
    }

    return {
        status,
        notes,
        metrics: { source: id, users, active, dormant_90d: dormant, dormant_pct: dormantPct, mfa, mfa_pct: mfaPct, admins: p.admins ?? null },
    };
}

module.exports = {
    id: 'ISO27001-A.5.16-identity-hygiene',
    regulation: 'ISO27001',
    article: 'A.5.16',
    controls: ['A.5.16', 'A.5.18', 'A.8.2'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(i)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_identity_hygiene.title',
    descriptionKey: 'compliance.checks.iso_identity_hygiene.desc',
    remediationKey: 'compliance.checks.iso_identity_hygiene.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const enabledSources = [];
        // Reads that failed. Both store functions run initDB first, so a throw
        // is a failed read, never "not enabled" or "no snapshot yet". It
        // degrades to warn without hiding the other directory's verdict.
        const unreadable = [];
        for (const id of SOURCES) {
            try {
                const config = await isoEvidenceStore.getConfig(orgId, id);
                if (config?.enabled) enabledSources.push(id);
            } catch (e) {
                unreadable.push({ connector: id, error_code: e?.code || null });
            }
        }
        if (!enabledSources.length) {
            if (unreadable.length) return unreadableConnector(unreadable[0].connector, { code: unreadable[0].error_code });
            return {
                status: 'not_applicable',
                evidence: { connectors: SOURCES, enabled: [] },
                details: 'No directory connector enabled — link Google Workspace or Microsoft Entra under ISO 27001 → Connectors to assess the account population.',
            };
        }

        const judged = [];
        const notes = [];
        let status = 'pass';
        const bump = (level) => { if (RANK[level] > RANK[status]) status = level; };

        for (const id of enabledSources) {
            let snaps;
            try {
                snaps = (await isoEvidenceStore.listLatestSnapshots(orgId, id)) || [];
            } catch (e) {
                unreadable.push({ connector: id, error_code: e?.code || null });
                continue;
            }
            const snap = snaps.find(s => s.subject_id === 'summary') || snaps[0];
            if (!snap) {
                bump('warn');
                notes.push(`${id}: enabled but no snapshot yet — run a sweep`);
                continue;
            }
            const r = _judgeSource(id, snap.payload || {});
            judged.push({ ...r.metrics, fetched_at: snap.fetched_at });
            notes.push(...r.notes);
            bump(r.status);
        }

        for (const u of unreadable) {
            bump('warn');
            notes.push(`${u.connector}: configuration or snapshots could not be read${u.error_code ? ` (SQL state ${u.error_code})` : ''}, so it was not assessed this run`);
        }

        if (!judged.length) {
            if (unreadable.length) {
                return { status: 'warn', evidence: { enabled: enabledSources, snapshots: 0, unreadable }, details: `Identity hygiene was not assessed: ${notes.join('; ')}.` };
            }
            return {
                status: 'warn',
                evidence: { enabled: enabledSources, snapshots: 0 },
                details: 'Directory connector enabled but no snapshot yet — run a sweep under ISO 27001 → Connectors.',
            };
        }

        const evidence = { sources: judged, thresholds: { dormant_fail_pct: DORMANT_FAIL_PCT, dormant_warn_pct: DORMANT_WARN_PCT, mfa_fail_pct: MFA_FAIL_PCT, mfa_warn_pct: MFA_WARN_PCT } };
        if (unreadable.length) evidence.unreadable = unreadable;
        if (status === 'pass') {
            return {
                status,
                evidence,
                details: `Dormant accounts and MFA enrolment are within thresholds across ${judged.length} directory source(s).`,
            };
        }
        return { status, evidence, details: `Identity hygiene issues: ${notes.join('; ')}.` };
    },
};
