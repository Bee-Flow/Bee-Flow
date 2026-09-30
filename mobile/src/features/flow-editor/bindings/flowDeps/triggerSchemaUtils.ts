/**
 * The params-list rows of an agent-callable trigger ↔ the JSON Schema stored
 * on it (`trigger.parametersSchema`). Inverses, so the editor round-trips.
 * Port of agent-hub `Builder/flow/triggerSchemaUtils.js`; pinned by
 * flowDeps.lockstep.test.ts.
 */

import { arr, isObj, obj, prop } from '../json';
import type { TriggerParam } from '../types';

/** params-list rows → JSON Schema. */
export function paramsToSchema(params: unknown): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of arr(params)) {
        if (!isObj(p) || !p.name) continue;
        const name = p.name as string;
        properties[name] = { type: p.type || 'string', ...(p.description ? { description: p.description } : {}) };
        if (p.required) required.push(name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** JSON Schema → params-list rows. */
export function schemaToParams(schema: unknown): TriggerParam[] {
    const props = schema && typeof schema === 'object' ? obj(prop(schema, 'properties')) : {};
    const required = arr(prop(schema, 'required'));
    return Object.entries(props).map(([name, p]) => ({
        name,
        type: (prop(p, 'type') as string) || 'string',
        required: required.includes(name),
        description: (prop(p, 'description') as string) || '',
    }));
}
