import { canonicalRefPath, previewValue, walkPath } from '../../../../utils/bindingHelpers';
import { type TranslateParams } from '../../../../hooks/useTranslation';
import { fieldValueLabel } from './VariableTree';
import type { GroupField, UpstreamGroup } from './deepFields';
import type { UpstreamField } from '../../../../hooks/useUpstreamVariables';

/** The group whose basePath owns `path` — the longest one that is a prefix. */
export function groupForPath(groups: UpstreamGroup[], path: string) {
    const p = canonicalRefPath(String(path || '').trim());
    if (!p) return null;
    let best: UpstreamGroup | null = null;
    for (const g of groups || []) {
        const base = g.basePath ? canonicalRefPath(String(g.basePath)) : '';
        if (!base) continue;
        if (p === base || p.startsWith(`${base}.`) || p.startsWith(`${base}[`)) {
            if (!best || base.length > String(best.basePath).length) best = g;
        }
    }
    return best;
}

export function resolveLeafPreview(field: UpstreamField, sampleRoot: unknown) {
    if (!field) return null;
    if (sampleRoot) {
        const v = walkPath(field.path, sampleRoot);
        if (v !== undefined) return previewValue(v, 60);
    }
    if (field.sample !== undefined) return previewValue(field.sample, 60);
    return null;
}

/**
 * What a row shows after its name: the Comes-in panel's own wording
 * (VariableTree.fieldValueLabel) — a column's first values "a · b · c", a
 * text “quoted” — so the {} picker and the panel never describe one field two
 * ways. Only a list of records that does not open into its columns keeps its
 * count ("[3 items]"), where the panel's wording is empty.
 */
export function leafValueText(field: GroupField, previewSample: unknown, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, hasChildren: boolean = false) {
    const label = fieldValueLabel(field, previewSample, t);
    if (label) return label;
    // A row that opens into its own fields shows them there; its count would
    // only repeat the "list · n" badge beside it.
    if (hasChildren) return '';
    const v = resolveLeafSample(field, previewSample);
    return Array.isArray(v) ? previewValue(v, 24) : '';
}

/**
 * The value a row's inline preview shows. For a `[*]` column path the stored
 * `field.sample` is the FIRST ELEMENT (collectionItemsFields convention), so
 * resolving through walkPath is the only honest source; plain paths keep the
 * cheap field.sample fallback.
 */
function resolveLeafSample(field: GroupField, sampleRoot: unknown) {
    if (sampleRoot && String(field.path || '').includes('[*]')) {
        const v = walkPath(field.path, sampleRoot);
        if (v !== undefined) return v;
    }
    return field.sample;
}
