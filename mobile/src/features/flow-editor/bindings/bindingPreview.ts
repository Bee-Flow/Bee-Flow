/**
 * The "example" line under a binding, resolved against the sample root
 * (design-time samples merged with real/pinned data): a literal as itself, a
 * ref as the sample at its path, a template with every `{{path}}` filled, an
 * expression EVALUATED by the shared engine. `raw: false` (the visual editor)
 * shows nothing rather than leak a path with an internal id in it. Port of
 * agent-hub `Builder/mapping/bindingPreview.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import { isScalarList, replaceTemplate, templateText, tryEvaluate } from '@/shared/expr';

import type { BindingValue, Binding } from './types';
import { previewValue, walkPath } from './walkPath';

interface PreviewOpts {
    raw: boolean;
    listAs: SlotListAs;
    maxLen: number;
}

/** A ref's sample; a list of plain values reads as its values ("a, b"), as on the web. */
function previewRef(b: Binding, sampleRoot: unknown, { raw, listAs, maxLen }: PreviewOpts): string | null {
    if (!b.path) return null;
    if (!sampleRoot) return raw ? b.path : null;
    const v = walkPath(b.path, sampleRoot);
    if (v === undefined) return raw ? `(no sample for ${b.path})` : null;
    if (isScalarList(v) && (v as unknown[]).length) return previewValue(templateText(v, { lists: listAs === 'json' ? 'json' : 'join' }), maxLen);
    return previewValue(v, maxLen);
}

/**
 * A template filled the way the run fills it (server/automation/bind.js
 * interpolateTemplate): the runtime's quote-aware scan, walker and
 * templateText — "a, b" for a list of plain values, "name: Ann" for a record,
 * JSON in a slot that carries data (`listAs: 'json'`).
 */
function previewTemplate(b: Binding, sampleRoot: unknown, { raw, listAs, maxLen }: PreviewOpts): string | null {
    if (!b.value) return null;
    if (!sampleRoot) return raw ? (b.value as string) : null;
    let resolvedAny = false;
    const lists = listAs === 'json' ? 'json' : 'join';
    const filled = replaceTemplate(String(b.value), (inner, full) => {
        const v = walkPath(inner, sampleRoot);
        if (v === undefined) return raw ? full : '…';
        resolvedAny = true;
        return templateText(v, { lists }).replace(/\n/g, ' · ');
    });
    if (!raw && !resolvedAny) return null;
    return previewValue(filled, maxLen);
}

/** How a slot's run writes a list into text: prose, or JSON for data slots. */
export type SlotListAs = 'text' | 'json';

function previewExpr(b: Binding, sampleRoot: unknown, { raw, maxLen }: PreviewOpts): string | null {
    if (!b.value) return null;
    if (sampleRoot) {
        const { value, error } = tryEvaluate(b.value as string, sampleRoot);
        if (!error && value !== undefined) return previewValue(value, maxLen);
    }
    return raw ? `expr: ${b.value as string}` : null;
}

/** The example line for a binding, or null when there is nothing worth showing. */
export function previewBinding(
    binding: BindingValue,
    sampleRoot: unknown,
    { raw = true, listAs = 'text', maxLen = 60 }: { raw?: boolean; listAs?: SlotListAs; maxLen?: number } = {},
): string | null {
    if (!binding || typeof binding !== 'object') return null;
    const opts: PreviewOpts = { raw, listAs, maxLen };
    if (binding.kind === 'literal') {
        if (binding.value == null || binding.value === '') return null;
        return previewValue(binding.value, maxLen);
    }
    if (binding.kind === 'ref') return previewRef(binding, sampleRoot, opts);
    if (binding.kind === 'template') return previewTemplate(binding, sampleRoot, opts);
    if (binding.kind === 'expr') return previewExpr(binding, sampleRoot, opts);
    return null;
}

export interface BindingShape {
    isList: boolean;
    count: number | null;
    empty: boolean;
    first: unknown;
}

/**
 * The SHAPE a binding resolves to — is it a list, how many, is it empty — so
 * a field can warn instead of implying success. Same resolvers as the preview.
 */
export function previewBindingShape(binding: BindingValue, sampleRoot: unknown): BindingShape | null {
    if (!binding || typeof binding !== 'object' || !sampleRoot) return null;
    let v: unknown;
    if (binding.kind === 'ref') {
        if (!binding.path) return null;
        v = walkPath(binding.path, sampleRoot);
    } else if (binding.kind === 'expr') {
        if (!binding.value) return null;
        const { value, error } = tryEvaluate(binding.value as string, sampleRoot);
        if (error) return null;
        v = value;
    } else {
        return null;
    }
    if (v === undefined) return null;
    if (!Array.isArray(v)) return { isList: false, count: null, empty: false, first: v };
    return { isList: true, count: v.length, empty: v.length === 0, first: v[0] };
}
