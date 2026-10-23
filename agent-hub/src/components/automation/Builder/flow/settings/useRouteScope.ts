import { getList } from '@shared/expr/path.mjs';
import { useMemo } from 'react';
import { sampleToFields } from '../../mapping/upstream';
import type { Group } from '../../mapping/upstream/upstream.types';
import { humanizeFieldKey } from '../displayHelpers';
import { useElementSample } from './collectionEditors';
import { itemNameOf, ruleFieldMenu } from './routeEditorsModel';
import type { FieldOption } from './routeEditorsModel';
import type { RouteConfig } from './routeTypes';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** Named fields of every upstream step — the options in whole-run mode. */
function upstreamFieldOptions(groups: Group[] | null | undefined): FieldOption[] {
    const out: FieldOption[] = [];
    for (const g of (groups || [])) {
        for (const f of (g.fields || [])) {
            out.push({ path: f.path, label: humanizeFieldKey(f.key), sample: f.sample, group: g.label });
            for (const c of (f.children || [])) {
                out.push({
                    path: c.path,
                    label: `${humanizeFieldKey(f.key)} · ${humanizeFieldKey(c.key)}`,
                    sample: c.sample,
                    group: g.label,
                });
            }
        }
    }
    return out;
}

interface Args {
    route: RouteConfig;
    items: boolean;
    previewSample: unknown;
    pickerGroups: Group[];
    t: Translate;
}

/**
 * What the rule rows read from: the current item's sample, the `item` scope that
 * makes `item.<field>` resolve, the named fields on offer and the sample rows
 * "Suggest outputs" counts against.
 */
export function useRouteScope({ route, items, previewSample, pickerGroups, t }: Args) {
    const itemName = useMemo(() => itemNameOf(route.source), [route.source]);

    // Scope the per-item rules to the CURRENT ITEM: an `item` group + sample
    // root so `item.<field>` resolves, datatypes infer, and drag-to-map works.
    const elementSample = useElementSample(items ? route.source : '', previewSample);
    const itemScope = useMemo(() => {
        if (!items || elementSample == null) return null;
        const isObj = typeof elementSample === 'object' && !Array.isArray(elementSample);
        const itemGroup = {
            id: '__route_item',
            label: 'Current item',
            kind: 'loop',
            basePath: 'item',
            sample: elementSample,
            fields: isObj ? sampleToFields(elementSample, 'item') : [],
        };
        return {
            groups: [itemGroup, ...(pickerGroups || [])],
            previewSample: { ...(previewSample || {}), item: elementSample },
        };
    }, [items, elementSample, pickerGroups, previewSample]);

    // The named fields the rule rows offer. In list mode they are the fields of
    // one item ("Subject", "From"); otherwise everything the upstream steps
    // produce, grouped by step. Paths stay internal — see FieldPicker.
    const fieldOptions = useMemo(
        () => (items ? ruleFieldMenu(elementSample, itemName, t) : upstreamFieldOptions(pickerGroups)),
        [items, elementSample, itemName, t, pickerGroups],
    );

    // The sample rows "Suggest outputs" counts against. They are the rows the
    // editor ALREADY has — whatever the step above last produced, resolved
    // through the same path the rules will be evaluated against — never
    // anything invented for the preview. In whole-run mode there is no list to
    // count, and the box says so rather than reporting "1 of 1". Read with
    // the run's own list reader, so a list held as JSON text counts too (R10).
    const sampleRows = useMemo(
        () => (items && route.source && previewSample ? getList(previewSample, route.source) : null),
        [items, route.source, previewSample],
    );

    return { elementSample, itemScope, fieldOptions, sampleRows };
}
