/**
 * Cowork templates (usecases/coworkTemplates.mts), on `cowork_templates` (stores/ddl/cowork-templates-2026-11.js): the
 * coworks members saved for their organisation, to start from.
 *
 * Every read is scoped to one organisation: a template of another organisation does not exist for the caller (null,
 * the same as an id nobody used). A person without an organisation has none, and saves none: the use case refuses
 * before it gets here. Deleting is narrowed in the SQL as well: only the template's creator, or a caller the use case
 * established administers the organisation.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; changes?: number } | unknown>;
    exec: (sql: string) => Promise<unknown>;
};

export interface CoworkTemplate {
    id: string;
    organizationId: string;
    createdBy: string | null;
    title: string;
    brief: string;
    repeatInterval: string | null;
    /** The cleaned plan definition, or null when the item had no approved plan. */
    definition: Record<string, unknown> | null;
    fingerprint: string | null;
    createdAt: string | null;
}

export interface NewTemplate {
    organizationId: string;
    createdBy: string;
    title: string;
    brief: string;
    repeatInterval: string | null;
    definition: Record<string, unknown> | null;
    fingerprint: string | null;
}

/** At most this many in one list: a gallery, not an archive. */
export const MAX_LISTED = 200;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function definitionOf(v: unknown): Record<string, unknown> | null {
    let value = v;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rowToTemplate(r: Row | null | undefined): CoworkTemplate | null {
    if (!r) return null;
    return {
        id: String(r.id),
        organizationId: String(r.organization_id),
        createdBy: r.created_by ? String(r.created_by) : null,
        title: String(r.title ?? ''),
        brief: String(r.brief ?? ''),
        repeatInterval: r.repeat_interval ? String(r.repeat_interval) : null,
        definition: definitionOf(r.definition),
        fingerprint: r.fingerprint ? String(r.fingerprint) : null,
        createdAt: iso(r.created_at),
    };
}

const changed = (result: unknown): number => {
    const r = result as { rowCount?: number | null; changes?: number } | null;
    return Number(r?.rowCount ?? r?.changes ?? 0);
};

export function makeCoworkTemplates({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    async function create(input: NewTemplate): Promise<CoworkTemplate> {
        await ready();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO cowork_templates (id, organization_id, created_by, title, brief, repeat_interval, definition, fingerprint)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
            [id, input.organizationId, input.createdBy, input.title, input.brief, input.repeatInterval,
                input.definition ? JSON.stringify(input.definition) : null, input.fingerprint],
        );
        const made = await get(id, input.organizationId);
        if (!made) throw new Error('the template was not stored');
        return made;
    }

    /** The organisation's templates, newest first. */
    async function listForOrg(organizationId: string): Promise<CoworkTemplate[]> {
        await ready();
        const rows = await db.getAll(
            'SELECT * FROM cowork_templates WHERE organization_id = $1 ORDER BY created_at DESC, id LIMIT $2',
            [organizationId, MAX_LISTED],
        );
        return rows.map((r) => rowToTemplate(r) as CoworkTemplate);
    }

    /** One template of this organisation, or null (also for one of another organisation). */
    async function get(id: string, organizationId: string): Promise<CoworkTemplate | null> {
        await ready();
        return rowToTemplate(await db.getOne('SELECT * FROM cowork_templates WHERE id = $1 AND organization_id = $2', [id, organizationId]));
    }

    /**
     * Delete a template of this organisation: as its creator, or (`asAdmin`) as someone who administers the
     * organisation. False when nothing matched.
     */
    async function remove(id: string, organizationId: string, by: { userId: string; asAdmin: boolean }): Promise<boolean> {
        await ready();
        const result = await db.run(
            'DELETE FROM cowork_templates WHERE id = $1 AND organization_id = $2 AND ($3::boolean OR created_by = $4)',
            [id, organizationId, by.asAdmin, by.userId],
        );
        return changed(result) > 0;
    }

    return { create, listForOrg, get, remove };
}

export type CoworkTemplateStore = ReturnType<typeof makeCoworkTemplates>;

type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised); storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkTemplatesStore', async () => {
    const { TEMPLATE_DDL } = nodeRequire('./ddl/cowork-templates-2026-11.js') as { TEMPLATE_DDL: readonly string[] };
    const db = nodeRequire('../db.js') as Db;
    for (const sql of TEMPLATE_DDL) await db.exec(sql);
});

let defaultTemplates: CoworkTemplateStore | null = null;

/** The store on the server's pool, after its schema is there. */
export function coworkTemplates(): CoworkTemplateStore {
    if (!defaultTemplates) defaultTemplates = makeCoworkTemplates({ ready: initDB });
    return defaultTemplates;
}
