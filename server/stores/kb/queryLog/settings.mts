/**
 * settings.mts: read and write the query-log settings of one knowledge base (enabled, term, names,
 * high-risk flag, the organisation's attestation). The route audits first and calls these; the
 * store never audits and never deletes rows itself.
 */

import type { Db, QueryLogSettings, SettingsPatch } from './types.mts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

export function makeSettingsFns(db: Db, clock: () => Date) {
    async function recomputeExpiry(kbId: string, retentionDays: number): Promise<number> {
        if (!UUID_RE.test(kbId)) return 0;
        return (await db.query(
            `UPDATE kb_query_log SET expires_at = created_at + ($2::int * interval '1 day') WHERE kb_id = $1::uuid`, [kbId, retentionDays])).rowCount || 0;
    }

    async function getQueryLogSettings(kbId: string): Promise<QueryLogSettings | null> {
        if (!UUID_RE.test(kbId)) return null;
        const { rows } = await db.query(
            `SELECT query_log_enabled, query_log_retention_days, query_log_changed_at, query_log_changed_by, query_log_attestation,
                    query_log_attested_by, query_log_attested_at, query_log_show_names, query_log_ai_act_high_risk
             FROM knowledge_bases WHERE id = $1::uuid`, [kbId]);
        const r = rows[0];
        if (!r) return null;
        return {
            enabled: !!r.query_log_enabled, retentionDays: Number(r.query_log_retention_days), changedAt: iso(r.query_log_changed_at), changedBy: r.query_log_changed_by ?? null,
            attestation: r.query_log_attestation ?? null, attestedBy: r.query_log_attested_by ?? null, attestedAt: iso(r.query_log_attested_at),
            showNames: r.query_log_show_names === true, aiActHighRisk: r.query_log_ai_act_high_risk === true,
        };
    }

    /**
     * Change the settings of one KB; returns the old and new values for the audit.
     * Anything left undefined keeps its value. A new retention term recomputes expires_at of the
     * existing rows of that KB. Every change moves `changed_at`, which makes earlier acknowledgements stale.
     */
    async function setQueryLogSettings(kbId: string, p: SettingsPatch) {
        const old = await getQueryLogSettings(kbId);
        if (!old) return null;
        const next = {
            enabled: p.enabled ?? old.enabled, retentionDays: p.retentionDays ?? old.retentionDays,
            showNames: p.showNames ?? old.showNames, aiActHighRisk: p.aiActHighRisk ?? old.aiActHighRisk,
        };
        const at = clock().toISOString();
        await db.query(
            `UPDATE knowledge_bases SET query_log_enabled = $2, query_log_retention_days = $3, query_log_changed_at = $4, query_log_changed_by = $5,
                    query_log_show_names = $6, query_log_ai_act_high_risk = $7,
                    query_log_attestation = CASE WHEN $8::jsonb IS NULL THEN query_log_attestation ELSE $8::jsonb END,
                    query_log_attested_by = CASE WHEN $8::jsonb IS NULL THEN query_log_attested_by ELSE $5 END,
                    query_log_attested_at = CASE WHEN $8::jsonb IS NULL THEN query_log_attested_at ELSE $4::timestamptz END
             WHERE id = $1::uuid`,
            [kbId, next.enabled, next.retentionDays, at, p.changedBy ?? null, next.showNames, next.aiActHighRisk,
                p.attestation ? JSON.stringify(p.attestation) : null]);
        if (next.retentionDays !== old.retentionDays) await recomputeExpiry(kbId, next.retentionDays);
        return { old: { enabled: old.enabled, retentionDays: old.retentionDays, showNames: old.showNames, aiActHighRisk: old.aiActHighRisk }, new: next };
    }

    return { recomputeExpiry, getQueryLogSettings, setQueryLogSettings };
}
