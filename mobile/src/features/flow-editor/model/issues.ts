/**
 * Validation issues, per step and per editor section — ports of the web
 * builder's flow/matchValidationToStep.js and flow/sectionForIssue.js, pinned
 * by issues.lockstep.test.ts.
 *
 * Server records carry an id-based `path` (`steps[<id>].expr`,
 * `triggers[<id>]…`, `trigger.kind`); a step's issues are the records whose
 * path contains its id. The section a record belongs to comes from the
 * step type's issue map in nodeDefs, so an error always opens the section
 * that holds the control to fix it — never one it cannot be fixed in.
 */

import { FLAT, NODE_DEFS, SYNTHETIC_TYPES, type IssueSections } from './nodeDefs';
import type { DefinitionInput, Validation, ValidationIssue } from './types';

export interface StepIssues {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
}

/** The records about one step: those whose path names its id. */
export function matchValidationToStep(validation: Validation | null | undefined, stepId: string | null | undefined): StepIssues {
    if (!validation || !stepId) return { errors: [], warnings: [] };
    const matches = (rec: ValidationIssue) => typeof rec?.path === 'string' && rec.path.includes(stepId);
    return {
        errors: (validation.errors || []).filter(matches),
        warnings: (validation.warnings || []).filter(matches),
    };
}

/** An expanded container on the canvas, as its inline ids are grouped. */
export interface InlineScope {
    kind: 'loop' | 'flowlet';
    callStepId?: string;
    layerKey?: string;
    childIds?: string[];
}

function scopedIssues(validation: Validation | null | undefined, prefix: string, entry: InlineScope, out: Map<string, StepIssues>) {
    const scope = entry.kind === 'loop' ? `steps[${entry.callStepId}].body.` : `layers.${entry.layerKey}.`;
    const inScope = (rec: ValidationIssue) =>
        typeof rec?.path === 'string' && (entry.kind === 'loop' ? rec.path.includes(scope) : rec.path.startsWith(scope));
    const errors = (validation?.errors || []).filter(inScope);
    const warnings = (validation?.warnings || []).filter(inScope);
    if (!errors.length && !warnings.length) return;
    for (const childId of entry.childIds || []) {
        const local = childId.slice(prefix.length + 1);
        const m = {
            errors: errors.filter((r) => (r.path as string).includes(local)),
            warnings: warnings.filter((r) => (r.path as string).includes(local)),
        };
        if (m.errors.length || m.warnings.length) out.set(childId, m);
    }
}

/**
 * Map<stepId, {errors, warnings}> across the whole graph (secondary
 * triggers included), plus the children of expanded containers when a
 * `sidecar` of inline scopes is given.
 */
export function buildIssuesByStep(
    validation: Validation | null | undefined,
    def: DefinitionInput,
    sidecar: Iterable<[string, InlineScope]> | null = null,
): Map<string, StepIssues> {
    const out = new Map<string, StepIssues>();
    if (!def) return out;
    const ids = [
        def.trigger?.id,
        ...(Array.isArray(def.triggers) ? def.triggers.map((t) => t?.id) : []),
        ...(def.steps || []).map((s) => s.id),
    ].filter((id): id is string => !!id);
    for (const id of ids) {
        const m = matchValidationToStep(validation, id);
        if (m.errors.length || m.warnings.length) out.set(id, m);
    }
    for (const [prefix, entry] of sidecar || []) scopedIssues(validation, prefix, entry, out);
    return out;
}

/** Per step type: `{fallback, map}` — canvas-only types have no editor. */
export const TAXONOMY: Readonly<Record<string, IssueSections>> = Object.fromEntries(
    Object.entries(NODE_DEFS)
        .filter(([type]) => !SYNTHETIC_TYPES[type])
        .map(([type, def]) => [type, def.issueSections as IssueSections]),
);

/** The path's tail after the step id (or after `trigger`). */
function fieldTail(path: unknown, stepId: string | undefined): string {
    if (typeof path !== 'string') return '';
    let tail = path;
    const idIdx = stepId ? path.indexOf(stepId) : -1;
    if (idIdx >= 0) tail = path.slice(idIdx + (stepId as string).length);
    else if (path.startsWith('trigger')) tail = path.slice('trigger'.length);
    return tail.replace(/^\]?\.?/, '');
}

const leadingSegment = (tail: string) => String(tail).split(/[.[\]]/).filter(Boolean)[0] || '';

type StepRef = { id?: string; type?: string } | null | undefined;

/**
 * The editor section one record belongs to: null for a flat, always-visible
 * field (or no field at all); the type's fallback for an unknown tail.
 */
export function sectionForIssue(step: StepRef, record: ValidationIssue | null | undefined): string | null {
    const tax = step?.type && Object.prototype.hasOwnProperty.call(TAXONOMY, step.type) ? TAXONOMY[step.type] : undefined;
    if (!step || !tax) return null;
    const seg = leadingSegment(fieldTail(record?.path, step.id));
    if (!seg) return null;
    const section = Object.prototype.hasOwnProperty.call(tax.map, seg) ? tax.map[seg] : undefined;
    if (section === FLAT) return null;
    return section || tax.fallback;
}

/** The sections holding at least one ERROR — the ones that must be forced open. */
export function sectionsWithErrors(step: StepRef, stepIssues: Partial<StepIssues> | null | undefined): Set<string> {
    const out = new Set<string>();
    if (!step || !stepIssues) return out;
    for (const rec of stepIssues.errors || []) {
        const section = sectionForIssue(step, rec);
        if (section) out.add(section);
    }
    return out;
}

/**
 * Which known step a record is about: the LONGEST id its path contains, so a
 * short id cannot shadow a longer one that contains it.
 */
export function resolveOwningStepId(record: ValidationIssue | null | undefined, def: DefinitionInput): string | null {
    const path = record?.path;
    if (typeof path !== 'string' || !def) return null;
    const allIds = [def.trigger?.id, ...(def.steps || []).map((s) => s.id)].filter((id): id is string => !!id);
    let best: string | null = null;
    for (const id of allIds) {
        if (path.includes(id) && (!best || id.length > best.length)) best = id;
    }
    return best;
}

/** Replace every KNOWN step id in a message with its quoted label. */
export function humanizeIssueText(text: string, labelById: Map<string, string> | null | undefined): string {
    if (!text || typeof text !== 'string' || !labelById?.size) return text;
    const ids = [...labelById.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!ids.length) return text;
    const pattern = new RegExp(`\\b(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
    return text.replace(pattern, (id) => `"${labelById.get(id) || id}"`);
}
