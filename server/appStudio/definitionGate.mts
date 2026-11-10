/**
 * App Studio — the definition gate for writers that store a definition as it
 * was handed to them (Blueprint install, Solution upgrade, stage deploy,
 * version restore) or that canonicalize without validating (template create and
 * upgrade).
 *
 * It answers a verdict and findings. It NEVER hands rewritten bytes back: the
 * install and stage stamps hash the payload as written, so a writer stores what
 * it was given or nothing at all.
 *
 *   refuse  the input is not an object, or its schema version is newer than
 *           this installation reads. Nothing else refuses.
 *   warn    the validator has ERRORS for it (it would not pass a publish), or
 *           the check itself could not run. The writer goes on and reports
 *           the findings.
 *   ok      no validator error. `warnings` may still be filled: validator
 *           warnings alone are what a save lets through without comment, and
 *           every shipped template carries some.
 *
 * `repairs` is what canonicalize would change (reported, not applied). The gate
 * does not throw: a writer that must not fail (stage compensate) can call it.
 */

import { createRequire } from 'node:module';
import { isSchemaNewer, schemaNewerMessage, SCHEMA_NEWER } from './schemaSince.mts';

export interface GateFinding {
    code: string;
    severity?: string;
    path?: string;
    message?: string;
    hint?: string;
    [key: string]: unknown;
}

export type GateVerdict = 'ok' | 'warn' | 'refuse';

export interface GateResult {
    verdict: GateVerdict;
    /** Why a refusal refused: 'not_object' or 'schema_newer'. null otherwise. */
    refused: 'not_object' | typeof SCHEMA_NEWER | null;
    repairs: unknown[];
    errors: GateFinding[];
    warnings: GateFinding[];
}

const nodeRequire = createRequire(import.meta.url);

function refusal(refused: 'not_object' | typeof SCHEMA_NEWER, message: string): GateResult {
    const code = refused === SCHEMA_NEWER ? 'shape.schema_newer' : 'shape.not_object';
    return { verdict: 'refuse', refused, repairs: [], errors: [{ code, severity: 'error', path: '', message, hint: '' }], warnings: [] };
}

/**
 * Canonicalize a COPY of `definition` and validate that copy: the check every
 * reader of stored bytes needs (the validator assumes canonical input). Throws
 * what canonicalize or the validator throws.
 */
export function canonicalizeAndValidate(definition: unknown, validateOpts: Record<string, unknown> = {}): {
    canonical: unknown; repairs: unknown[]; errors: GateFinding[]; warnings: GateFinding[];
} {
    const { canonicalizeAppDefinition } = nodeRequire('./canonicalize') as {
        canonicalizeAppDefinition: (def: unknown) => { def: unknown; repairs?: unknown[] };
    };
    const { validateAppDefinition } = nodeRequire('./validate') as {
        validateAppDefinition: (def: unknown, opts?: Record<string, unknown>) => { errors: GateFinding[]; warnings: GateFinding[] };
    };
    const canon = canonicalizeAppDefinition(structuredClone(definition));
    const checked = validateAppDefinition(canon.def, validateOpts);
    return { canonical: canon.def, repairs: Array.isArray(canon.repairs) ? canon.repairs : [], errors: checked.errors, warnings: checked.warnings };
}

/**
 * @param definition    the bytes a writer is about to store
 * @param validateOpts  passed to validateAppDefinition (owned automations, data model, ...)
 */
export function gateDefinition(definition: unknown, validateOpts: Record<string, unknown> = {}): GateResult {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
        return refusal('not_object', 'The app definition is not an object.');
    }
    if (isSchemaNewer(definition)) return refusal(SCHEMA_NEWER, schemaNewerMessage(definition));
    try {
        // On a copy: the caller's object is what gets written and hashed.
        const { repairs, errors, warnings } = canonicalizeAndValidate(definition, validateOpts);
        return { verdict: errors.length ? 'warn' : 'ok', refused: null, repairs, errors, warnings };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            verdict: 'warn', refused: null, repairs: [],
            errors: [{ code: 'gate.check_failed', severity: 'error', path: '', message, hint: '' }], warnings: [],
        };
    }
}

/**
 * The findings a response or report carries for a gated write, or null when the
 * verdict is ok. Without `repairs`: they are not applied, and they name ids
 * canonicalize would generate, which differ on every call.
 */
export function gateFindings(gate: GateResult): { errors: GateFinding[]; warnings: GateFinding[] } | null {
    if (gate.verdict === 'ok') return null;
    return { errors: gate.errors, warnings: gate.warnings };
}
