/**
 * The content hash of a stored definition: sha256 of its key-sorted JSON.
 *
 * An App Studio app installed from a template, and every part a Blueprint
 * install or upgrade writes, is stamped with this hash of the definition AS
 * SAVED; it is "pristine" (safe to upgrade in place) while its current
 * definition still hashes the same. The definition lives in a Postgres JSONB
 * column, and jsonb does not preserve object key order, so the text is
 * key-sorted (stableStringify, JSON's drop rule for undefined) rather than a
 * plain JSON.stringify of the read-back object.
 *
 * App Studio (appStudio/templateUpgrade.js and its callers) and projects/
 * packaging both stamp and compare with it, so it lives below both.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const stableJson = nodeRequire('../../utils/stableJson') as { stableStringify: (v: unknown, o: { undefined: 'drop' }) => string };

/** sha256 hex of the canonical JSON of a definition object. */
export function hashDefinition(definition: unknown): string {
    return crypto.createHash('sha256').update(stableJson.stableStringify(definition ?? {}, { undefined: 'drop' }), 'utf8').digest('hex');
}
