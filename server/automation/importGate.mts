/**
 * importGate.mts: the activation gate of an automation imported from
 * Windmill (PLAN B5), and the dry-run mark it reads.
 *
 * An imported draft goes live only when
 *   1. every item of its AI checklist is resolved (a placeholder step is gone or
 *      no longer a stop step; a step it asked to finish was changed since the
 *      import) or explicitly acknowledged by a person, and
 *   2. a dry run of the CURRENT version ended without an error since the
 *      import (any later edit asks for a new one).
 * Once it has been switched on, the gate is done for good (`cleared_at`):
 * switching it off and on again is ordinary.
 *
 *   gateState(row, automation)               pure: what is still open
 *   importGateRefusal(automation, store?)    the HttpError the activate route throws, or null
 *   noteActivated(automationId, store?)      after a successful activation (best-effort)
 *   noteDryRun(automation, run, store?)      after a dry run of the SAVED definition
 *                                            (best-effort): marks a clean run of its version
 *
 * `store` is the automationStore facade (or a route's double of it). A store
 * without the import functions holds no imports, so nothing is gated; an
 * automation that was not imported has no row and is never gated either. The
 * gate does not depend on the licence: a lapse must not let a half-converted
 * draft go live.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ImportRow } from '../stores/automationImportStore.mts';

const nodeRequire = createRequire(import.meta.url);

type Automation = { id: string; version?: number | null; definition?: Record<string, any> | null };

/** The import functions of the automationStore facade; each is optional on a double. */
export interface GateStore {
    getImportForAutomation?: (automationId: string) => Promise<ImportRow | null>;
    markImportDryRunOk?: (automationId: string, version: number) => Promise<boolean>;
    markImportCleared?: (automationId: string) => Promise<void>;
}

const facade = (): GateStore => nodeRequire('../stores/automationStore') as GateStore;

export interface OpenItem {
    wmId: string;
    stepId: string | null;
    title: string;
}

export interface GateState {
    applies: boolean;
    open: OpenItem[];
    dryRunRequired: boolean;
    dryRunCurrent: boolean;
}

/** Every node of the definition that carries an id and a type, at any depth (root, layers, branches, bodies). */
export function stepTypesById(definition: unknown): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, node] of stepsById(definition)) out.set(id, String(node.type));
    return out;
}

/** The same nodes, whole. */
export function stepsById(definition: unknown): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    const seen = new Set<unknown>();
    const walk = (v: unknown, depth: number): void => {
        if (!v || typeof v !== 'object' || depth > 40 || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
        const o = v as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.type === 'string' && !out.has(o.id)) out.set(o.id, o);
        for (const x of Object.values(o)) walk(x, depth + 1);
    };
    const def = (definition && typeof definition === 'object' ? definition : {}) as Record<string, unknown>;
    walk(def.steps, 0);
    walk(def.layers, 0);
    return out;
}

/** JSON with sorted keys: the definition is stored as JSONB, which does not keep key order. */
function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
    }
    return v;
}

/** A fingerprint of one step as stored, to tell later whether anybody changed it. */
export function stepFingerprint(step: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonical(step))).digest('hex').slice(0, 32);
}

/**
 * The checklist as stored with the draft: per item whether its step was a
 * placeholder (a stop step) at import, and otherwise the fingerprint of the
 * step it asks to finish. A placeholder is resolved once it is no longer a
 * stop step; any other item once its step changed (or went).
 */
export function markChecklist<T extends { stepId?: string | null }>(items: T[], storedDefinition: unknown): Array<T & { placeholder?: boolean; stepHash?: string }> {
    const steps = stepsById(storedDefinition);
    return items.map((item) => {
        const step = item.stepId ? steps.get(item.stepId) : undefined;
        if (!step) return item;
        return step.type === 'stop_error' ? { ...item, placeholder: true } : { ...item, stepHash: stepFingerprint(step) };
    });
}

function resolved(item: Record<string, unknown>, steps: Map<string, Record<string, unknown>>): boolean {
    const stepId = typeof item.stepId === 'string' && item.stepId ? item.stepId : null;
    if (!stepId) return false;
    const step = steps.get(stepId);
    if (item.placeholder) return !step || step.type !== 'stop_error';
    if (typeof item.stepHash === 'string') return !step || stepFingerprint(step) !== item.stepHash;
    return false;
}

export function gateState(row: ImportRow | null, automation: Automation): GateState {
    if (!row || row.clearedAt) return { applies: false, open: [], dryRunRequired: false, dryRunCurrent: false };
    const steps = stepsById(automation.definition);
    const acked = new Set(row.acknowledged);
    const checklist = Array.isArray(row.report?.aiChecklist) ? row.report.aiChecklist as Array<Record<string, unknown>> : [];
    const open: OpenItem[] = [];
    for (const item of checklist) {
        const wmId = String(item.wmId ?? '');
        if (!wmId || acked.has(wmId)) continue;
        const stepId = typeof item.stepId === 'string' && item.stepId ? item.stepId : null;
        if (resolved(item, steps)) continue;
        open.push({ wmId, stepId, title: String(item.title ?? wmId) });
    }
    const dryRunCurrent = row.dryRunVersion != null && automation.version != null && row.dryRunVersion === Number(automation.version);
    return { applies: true, open, dryRunRequired: !dryRunCurrent, dryRunCurrent };
}

/** The refusal of the activate route, or null when the automation may go live. */
export async function importGateRefusal(automation: Automation, store: GateStore = facade()): Promise<Error | null> {
    if (typeof store.getImportForAutomation !== 'function') return null;
    const state = gateState(await store.getImportForAutomation(automation.id), automation);
    if (!state.applies) return null;
    const { HttpError } = nodeRequire('../core/http/errors') as { HttpError: new (status: number, code: string, message: string, details?: unknown) => Error };
    if (state.open.length) {
        return new HttpError(409, 'import.windmill.placeholders_left',
            `This automation came from Windmill and ${state.open.length} part(s) still need converting. Complete them (or mark them as handled) in the import report before switching it on.`,
            { open: state.open });
    }
    if (state.dryRunRequired) {
        return new HttpError(409, 'import.windmill.dry_run_required',
            'This automation came from Windmill. Run a dry run of this version without errors before switching it on.');
    }
    return null;
}

function noteFailure(where: string, err: unknown): void {
    const { bestEffort } = nodeRequire('../utils/bestEffort') as { bestEffort: (w: string, e: unknown) => void };
    bestEffort(where, err);
}

/** The draft went live: the gate is done. Never throws. */
export async function noteActivated(automationId: string, store: GateStore = facade()): Promise<void> {
    if (typeof store.markImportCleared !== 'function') return;
    try { await store.markImportCleared(automationId); } catch (e) { noteFailure('automation/importGate:noteActivated', e); }
}

/**
 * After a dry run: a run that ended in `success` marks the version it ran.
 * A run of a definition that is not the saved one (the builder's preview of
 * a proposal) must not be passed here. Never throws.
 */
export async function noteDryRun(automation: Automation | null | undefined, run: { status?: string; mode?: string; version?: number | null } | null | undefined, store: GateStore = facade()): Promise<void> {
    if (!automation?.id || !run || run.status !== 'success' || (run.mode && run.mode !== 'dry_run')) return;
    if (typeof store.markImportDryRunOk !== 'function') return;
    const version = run.version ?? automation.version;
    if (version == null) return;
    try { await store.markImportDryRunOk(automation.id, Number(version)); } catch (e) { noteFailure('automation/importGate:noteDryRun', e); }
}
