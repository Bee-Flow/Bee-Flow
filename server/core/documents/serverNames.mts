/**
 * The names the document routes give what a person did not name themselves (a
 * new spreadsheet, a new tab, a copy), in that person's own language: their
 * preferred locale from their account, the English default when it has none or
 * the lookup fails. The words live in the `doc_server` i18n namespace
 * (i18n/defaults/en/doc_server.js, nl/doc_server.json).
 *
 *   await serverName(userId, 'doc_server.copy_name', { name: doc.name })  → "Plan — kopie"
 *
 * The lookups are injectable for tests; nothing here throws.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type Translate = (locale: string, key: string, vars: Record<string, unknown>) => Promise<string>;
export interface NameDeps {
    /** The user row, for its preferredLocale (stores/userStore.getUser). */
    getUser?: (userId: string) => Promise<{ preferredLocale?: string | null } | null | undefined>;
    /** i18n/translate.translate. */
    translate?: Translate;
}

/** The language a user reads in: their account's preferred locale, else 'en'. */
export async function readerLocale(userId: string, deps: NameDeps = {}): Promise<string> {
    const getUser = deps.getUser || ((id: string) => nodeRequire('../../stores/userStore').getUser(id));
    try {
        return (await getUser(userId))?.preferredLocale || 'en';
    } catch {
        return 'en';
    }
}

/** `key` in `userId`'s language, with `vars` filled in. */
export async function serverName(userId: string, key: string, vars: Record<string, unknown> = {}, deps: NameDeps = {}): Promise<string> {
    const translate: Translate = deps.translate || ((locale, k, v) => nodeRequire('../../i18n/translate').translate(locale, k, v));
    const locale = await readerLocale(userId, deps);
    try {
        return await translate(locale, key, vars);
    } catch {
        const { GUI_DEFAULTS } = nodeRequire('../../i18n/defaults/en');
        return nodeRequire('../../i18n/translate').fill(GUI_DEFAULTS[key] || key, vars);
    }
}
