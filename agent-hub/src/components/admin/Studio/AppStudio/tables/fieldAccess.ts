import type { ModelField } from './tablesManagerModel';

/**
 * Column rights of a data-model field, as the table editor edits them:
 * `field.access = { read?: [roleKey], write?: [roleKey] }`. The server enforces
 * them on every read and write (core/dataEngine/columnRights.mts) and judges
 * the shape when the model is saved.
 *
 * A list that is absent means "no limit" (for write: the roles that read the
 * field); an empty list means the owner only. Every helper returns a NEW field
 * and removes a key instead of writing it empty, so a field nobody limited
 * keeps exactly the bytes it had.
 */

export type AccessKey = 'read' | 'write';

export interface FieldAccess {
    read?: string[];
    write?: string[];
}

/** The role every app has for visitors of its public pages. */
export const PUBLIC_ROLE = 'public';

export function accessOf(field: ModelField): FieldAccess {
    const a = field.access;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return {};
    const out: FieldAccess = {};
    for (const key of ['read', 'write'] as const) {
        const list = (a as Record<string, unknown>)[key];
        if (Array.isArray(list)) out[key] = list.filter((r): r is string => typeof r === 'string');
    }
    return out;
}

/** The field with one list set, or removed (null); `access` goes when neither is left. */
export function withAccessList(field: ModelField, key: AccessKey, roles: string[] | null): ModelField {
    const next: FieldAccess = { ...accessOf(field) };
    if (roles === null) delete next[key];
    else next[key] = [...new Set(roles)];
    const { access: _old, ...rest } = field;
    return next.read || next.write ? { ...rest, access: next } : rest;
}

/** The field with `role` added to or taken out of one list. */
export function withRole(field: ModelField, key: AccessKey, role: string, on: boolean): ModelField {
    const current = accessOf(field)[key] || [];
    return withAccessList(field, key, on ? [...current, role] : current.filter((r) => r !== role));
}

/** Field types no person writes (the server computes or reads them). */
const NEVER_WRITTEN: readonly string[] = ['computed', 'autonumber', 'lookup', 'rollup'];

/** A field that no person writes has no write list. */
export function takesWriteList(field: ModelField): boolean {
    return !NEVER_WRITTEN.includes(field.type ?? '');
}

/** After a type change: a field that no person writes loses its write list (the server refuses one there). */
export function withAccessForType(field: ModelField): ModelField {
    return takesWriteList(field) || !accessOf(field).write ? field : withAccessList(field, 'write', null);
}

/** The role keys of a model's `roles` list, with the public role last. */
export function roleKeysOf(roles: unknown): string[] {
    const keys: string[] = [];
    for (const role of Array.isArray(roles) ? roles : []) {
        const roleKey = role && typeof role === 'object' ? (role as Record<string, unknown>)['key'] : null;
        if (typeof roleKey === 'string' && roleKey !== '' && roleKey !== PUBLIC_ROLE && !keys.includes(roleKey)) keys.push(roleKey);
    }
    return [...keys, PUBLIC_ROLE];
}
