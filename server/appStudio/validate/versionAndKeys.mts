/**
 * App Studio validator — the schema version of a definition and its
 * registered top-level keys (definitionKeyRegistry.mts).
 */

import { createRequire } from 'node:module';
import { requiredSchemaVersion, isSchemaNewer, schemaNewerMessage } from '../schemaSince.mts';
import { definitionKeys } from '../definitionKeyRegistry.mts';
import type { Finding } from '../definitionKeyRegistry.mts';
import { checkAssetRefs } from './assetChecks.mts';
import { checkScreenTriggers } from './clientTriggerChecks.mts';
import { checkLayout } from './layoutChecks.mts';
import { checkLookExtras } from './lookExtrasChecks.mts';

const nodeRequire = createRequire(import.meta.url);
const { SCHEMA_VERSION_BASE, SCHEMA_VERSION_CURRENT, SCHEMA_VERSIONS_ACCEPTED } = nodeRequire('../componentSpecs/ids.js') as {
    SCHEMA_VERSION_BASE: number;
    SCHEMA_VERSION_CURRENT: number;
    SCHEMA_VERSIONS_ACCEPTED: unknown[];
};

type Def = Record<string, unknown>;
type PushFinding = (finding: Finding) => void;

/**
 * The whole verdict for a definition from a newer install, or null. Such a
 * definition is not judged by rules that do not know what it holds: one
 * finding, nothing else.
 */
export function schemaNewerVerdict(def: Def): { ok: false; errors: Finding[]; warnings: Finding[] } | null {
    if (!isSchemaNewer(def)) return null;
    return {
        ok: false,
        errors: [{
            code: 'shape.schema_newer', severity: 'error', path: 'schemaVersion',
            message: schemaNewerMessage(def),
            hint: 'Update Bee Flow, or open the app on the installation it came from.',
        }],
        warnings: [],
    };
}

/**
 * Validation assumes canonical (post-migrate) input: any accepted version that
 * is at least what the content needs (the base, or the highest `since` it uses).
 */
export function checkSchemaVersion(def: Def, pushE: PushFinding): void {
    const required = Math.max(SCHEMA_VERSION_BASE, requiredSchemaVersion(def));
    const version = def.schemaVersion;
    if (SCHEMA_VERSIONS_ACCEPTED.includes(version) && (version as number) >= required) return;
    pushE({
        code: 'shape.schema_version', severity: 'error', path: 'schemaVersion',
        message: `schemaVersion must be ${required}${required < SCHEMA_VERSION_CURRENT ? ' or higher' : ''} (got ${JSON.stringify(version)}).`,
        hint: 'Run the definition through canonicalize (it migrates older versions and sets the version the content needs).',
    });
}

/**
 * The `validate` of every registered top-level key the definition carries, then the checks
 * that read the whole definition against something outside it: the uploaded files it names
 * (opts.assetIds, validate/assetChecks.mts), the screen triggers of schema 3
 * (validate/clientTriggerChecks.mts), and the layout knobs that cannot work where they
 * sit (validate/layoutChecks.mts).
 */
export function validateRegisteredKeys(def: Def, pushE: PushFinding, pushW: PushFinding, opts: { assetIds?: unknown } = {}): void {
    for (const entry of definitionKeys()) {
        if (def[entry.key] !== undefined && typeof entry.validate === 'function') {
            entry.validate(def[entry.key], { def, pushE, pushW });
        }
    }
    checkAssetRefs(def, opts.assetIds, pushW);
    checkScreenTriggers(def, { pushE, pushW });
    checkLayout(def, pushW);
    checkLookExtras(def, { pushE, pushW });
}
