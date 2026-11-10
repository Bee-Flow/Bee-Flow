import { autoMapping, type SchemaField, type TableColumn } from './aiFieldMatching';
import type { SchemaMeta, WriteTo } from './AiActionEditors.types';

/** Server LIMITS.MAX_AI_SCHEMA_FIELDS: canonicalize keeps the first 40 and drops the rest. */
export const MAX_AI_SCHEMA_FIELDS = 40;

/**
 * A schema edit, and the writeTo mapping that has to follow it.
 *
 * A renamed field follows its column (and adopts one if its new name now matches a free column),
 * and a removed field releases it. Without this the mapping points at a name that no longer exists
 * and the column silently writes null. Shared by the bare ai_extract editor and the sequence step
 * control, so both keep the mapping honest the same way.
 */
export function schemaEditPatch(schema: SchemaField[], meta: SchemaMeta | undefined, writeTo: WriteTo | undefined, columns: TableColumn[]): { schema: SchemaField[]; writeTo?: WriteTo } {
    const patch: { schema: SchemaField[]; writeTo?: WriteTo } = { schema };
    if (!writeTo?.tableId || !meta) return patch;
    const next: Record<string, string> = {};
    for (const [col, fieldName] of Object.entries(writeTo.mapping || {})) {
        if (meta.removed && fieldName === meta.removed) continue;
        next[col] = meta.renamed && fieldName === meta.renamed.from ? meta.renamed.to : fieldName;
    }
    // A rename onto a still-free column is an explicit "put it here".
    if (meta.renamed && !Object.values(next).includes(meta.renamed.to)) {
        const hit = autoMapping([{ name: meta.renamed.to }], columns.filter((col) => !(col.key in next)));
        Object.assign(next, hit);
    }
    patch.writeTo = { ...writeTo, mapping: next };
    return patch;
}

/**
 * A schema in the shape canonicalize stores (canonicalize/aiFields.cleanAiSchema): `description`
 * only when it says something, `required` only when true. The editor's rows carry an empty
 * description and `required: false` while they are being written; storing those would make the
 * saved step differ from what the server keeps.
 */
export function canonicalSchema(fields: SchemaField[]): SchemaField[] {
    return fields.map((f) => ({
        name: f.name,
        type: f.type || 'string',
        ...(typeof f.description === 'string' && f.description ? { description: f.description } : {}),
        ...(f.required === true ? { required: true } : {}),
    }));
}
