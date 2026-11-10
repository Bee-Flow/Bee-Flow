/**
 * App Studio validator: definition.roles, the role keys every visibleToRoles (screen, section,
 * node) resolves against. Moved out of validate.js unchanged.
 */

import { createRequire } from 'node:module';
import type { Finding } from '../definitionKeyRegistry.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs.js') as { LIMITS: { MAX_ROLES: number } };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** def.roles → a Set of role ids, validating the { id, name } shape. */
export function validateRolesAndCollect(def: Record<string, unknown>, pushE: (finding: Finding) => void): Set<string> {
    const ids = new Set<string>();
    if (def.roles === undefined) return ids;
    if (!Array.isArray(def.roles)) {
        pushE({ code: 'roles.invalid', severity: 'error', path: 'roles', message: 'roles must be an array of { id, name }.', hint: 'Use [] when the app has no roles.' });
        return ids;
    }
    if (def.roles.length > LIMITS.MAX_ROLES) {
        pushE({ code: 'roles.too_many', severity: 'error', path: 'roles', message: `App declares ${def.roles.length} roles — the maximum is ${LIMITS.MAX_ROLES}.`, hint: 'Remove unused roles.' });
    }
    def.roles.forEach((role: unknown, i: number) => {
        if (!isObject(role) || typeof role.id !== 'string' || !role.id) {
            pushE({ code: 'role.invalid', severity: 'error', path: `roles[${i}]`, message: 'Each role needs a non-empty string id.', hint: 'Use { id, name }.' });
            return;
        }
        if (ids.has(role.id)) {
            pushE({ code: 'role.duplicate', severity: 'error', path: `roles[${i}].id`, message: `Duplicate role id ${JSON.stringify(role.id)}.`, hint: 'Role ids must be unique.' });
            return;
        }
        ids.add(role.id);
    });
    return ids;
}
