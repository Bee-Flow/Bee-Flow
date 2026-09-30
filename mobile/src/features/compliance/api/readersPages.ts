/**
 * Contract readers for the pages that are not registers: ROPA, the Data Act
 * portability matrix, the access log, settings and the vault connections.
 *
 * Verified against server/routes/compliance/{ropa,portability,accessAudit,
 * settings,isoConnectors}.js and compliance/dataPortability/exportRegistry.js.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { idText } from './readersRegisters';

/** GET /api/compliance/ropa — the Art. 30 register built from live configuration. */
export const readRopa = shapeOf({
    controller: (v: unknown) => ({
        name: field.strOrNull(pick(v, 'name')),
        dpo_name: field.strOrNull(pick(v, 'dpo_name')),
        dpo_email: field.strOrNull(pick(v, 'dpo_email')),
    }),
    legal_bases: field.strArray,
    data_residency: field.strOrNull,
    last_reviewed_at: field.strOrNull,
    activities: field.list(shapeOf({
        activity_id: field.strOrNull,
        name: field.str(''),
        purpose: field.strOrNull,
        retention: field.strOrNull,
    })),
    processors: field.list(shapeOf({
        operator: field.str(''),
        country_code: field.strOrNull,
        is_eu: field.bool(false),
        calls: field.numOrNull,
        scc_confirmed: field.bool(false),
    })),
});
export type Ropa = ReturnType<typeof readRopa>;

/** GET /api/compliance/portability — one row per kind of data the org holds. */
export const readPortability = shapeListOf({
    kind: field.str(''),
    label_key: field.strOrNull,
    held: field.numOrNull,
    formats: field.strArray,
    mounted: field.bool(false),
    gap_key: field.strOrNull,
});
export type PortabilityRow = ReturnType<typeof readPortability>[number];

/** GET /api/compliance/access-audit — `{ entries, total, limit, offset }`. */
export const readAccessAudit = shapeOf({
    entries: field.list(shapeOf({
        id: idText,
        action: field.str(''),
        target_type: field.strOrNull,
        target_id: field.strOrNull,
        changed_by: field.strOrNull,
        created_at: field.strOrNull,
    })),
    total: field.num(0),
    limit: field.num(100),
    offset: field.num(0),
});
export type AccessAuditPage = ReturnType<typeof readAccessAudit>;

/** GET /api/compliance/access-audit/actions — `{ actions }`. */
export const readAuditActions = (raw: unknown): string[] => field.strArray(pick(raw, 'actions'));

/** GET /api/compliance/settings — a whitelist of columns the form reads by name. */
export const readSettings = (raw: unknown): Readonly<Record<string, unknown>> => field.record<Record<string, unknown>>({})(raw);

/** GET /iso/connectors/:id/connections — `[{ id, label, kind, provider }]`. */
export const readConnections = shapeListOf({ id: idText, label: field.strOrNull });
