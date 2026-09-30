/**
 * The catalog reader. Tolerant in both directions: every field named in
 * catalogTypes.ts is checked (a missing list is `[]`, a mistyped flag is its
 * stated default), and every field NOT named is carried through as it came —
 * the editor's pure modules read the catalog as an open object, as the web
 * builder does, and must see what a newer server adds. Rows that are not
 * objects, or have no id, are dropped rather than rendered as blanks.
 */

import { field, pick, shapeOf, type FieldReader } from '@/core/api/contract';

import type {
    CatalogActionRow,
    CatalogAgent,
    CatalogAppRow,
    CatalogBlock,
    CatalogChoice,
    CatalogDatatable,
    CatalogDatatableOp,
    CatalogFlags,
    CatalogKnowledgeBase,
    CatalogPickSource,
    CatalogTriggerKind,
    FlowCatalog,
} from './catalogTypes';
import type { JsonSchema, TriggerOutputEntry } from '../bindings/types';

type Obj = Record<string, unknown>;

function isRecord(value: unknown): value is Obj {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The spec'd fields validated, everything else kept. */
function tolerant<T>(read: (raw: unknown) => object): (raw: unknown) => T {
    return (raw) => ({ ...(isRecord(raw) ? raw : {}), ...read(raw) }) as T;
}

/** A list of object rows, each read tolerantly; rows without `idKey` are dropped. */
function rows<T>(read: (raw: unknown) => object, idKey: string): FieldReader<T[]> {
    const one = tolerant<T>(read);
    return (value) =>
        Array.isArray(value)
            ? value.filter(isRecord).map(one).filter((row) => typeof (row as Obj)[idKey] === 'string' && (row as Obj)[idKey] !== '')
            : [];
}

const anyList: FieldReader<unknown[]> = (value) => field.arrayOrNull(value) ?? [];
const record: FieldReader<Obj> = field.record<Obj>({});

const readAction = shapeOf({
    name: field.str(''),
    label: field.str(''),
    description: field.str(''),
    inputSchema: (v: unknown) => field.recordOrNull<JsonSchema>(v),
    outputSchema: field.raw,
    outputSample: field.raw,
    producesList: field.bool(false),
    listField: field.strOrNull,
    sideEffect: field.bool(false),
    effect: field.strOrNull,
    integrationId: field.str(''),
    integrationLabel: field.str(''),
});

const readApp = shapeOf({
    id: field.str(''),
    label: field.str(''),
    available: field.bool(false),
    connected: field.optBool,
    actions: rows<CatalogActionRow>(readAction, 'name'),
});

const readColumn = shapeOf({ key: field.str(''), name: field.optStr, type: field.optStr, unique: field.optBool });

const readDatatable = shapeOf({
    id: field.str(''),
    name: field.str(''),
    key: field.optStr,
    description: field.optStr,
    rowCount: field.optNum,
    canWrite: field.bool(false),
    managedKind: field.optStr,
    scope: field.optStr,
    columns: rows<CatalogDatatable['columns'][number]>(readColumn, 'key'),
});

const readKnowledgeBase = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.strOrNull,
    canWrite: field.bool(false),
    scope: field.strOrNull,
});

const readAgent = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.strOrNull,
    scope: field.strOrNull,
    canUse: field.bool(false),
    reason: field.strOrNull,
});

const readPickSource = shapeOf({
    id: field.str(''),
    appId: field.strOrNull,
    app: field.strOrNull,
    label: field.str(''),
    searchHint: field.str(''),
    internal: field.bool(false),
    sampleData: record,
    available: field.bool(false),
});

const readBlock = shapeOf({
    id: (v: unknown) => (typeof v === 'number' ? String(v) : field.str('')(v)),
    title: field.str(''),
    description: field.str(''),
    icon: field.strOrNull,
    category: field.strOrNull,
    params: anyList,
    outputFields: anyList,
    requiredIntegrations: field.strArray,
    available: field.bool(false),
});

const readTriggerKind = shapeOf({ kind: field.str(''), label: field.optStr, providers: field.optList(field.raw) });
const readTriggerMeta = shapeOf({ key: field.str(''), path: field.optStr, sample: field.raw, note: field.optStr });
const readChoice = shapeOf({ value: field.str(''), label: field.str(''), blurb: field.str('') });
const readOp = shapeOf({ op: field.str(''), label: field.str(''), blurb: field.str(''), writes: field.bool(false) });
const readFlags = tolerant<CatalogFlags>(
    shapeOf({ code: field.bool(false), codeReason: field.strOrNull, automations: field.bool(false) }),
);

const readCatalogFields = shapeOf({
    apps: rows<CatalogAppRow>(readApp, 'id'),
    datatables: rows<CatalogDatatable>(readDatatable, 'id'),
    knowledgeBases: rows<CatalogKnowledgeBase>(readKnowledgeBase, 'id'),
    agents: rows<CatalogAgent>(readAgent, 'id'),
    agentsError: field.strOrNull,
    formPickSources: rows<CatalogPickSource>(readPickSource, 'id'),
    knowledgeWriteStrategies: rows<CatalogChoice>(readChoice, 'value'),
    datatableOps: rows<CatalogDatatableOp>(readOp, 'op'),
    steps: rows<CatalogBlock>(readBlock, 'id'),
    triggerOutputs: (v: unknown) => field.record<Record<string, TriggerOutputEntry>>({})(v),
    triggerMeta: rows<FlowCatalog['triggerMeta'][number]>(readTriggerMeta, 'key'),
    deliverability: (v: unknown) => field.record<Record<string, Record<string, string[]>>>({})(v),
    stepTypes: field.strArray,
    triggers: rows<CatalogTriggerKind>(readTriggerKind, 'kind'),
    flags: readFlags,
});

/** The whole catalog. A payload that is not an object reads as an empty one. */
export const readCatalog: (raw: unknown) => FlowCatalog = tolerant<FlowCatalog>(readCatalogFields);

/** GET /catalog/form-pick-sources — the same rows, without the rest of the catalog. */
export function readPickSources(raw: unknown): CatalogPickSource[] {
    return rows<CatalogPickSource>(readPickSource, 'id')(pick(raw, 'sources'));
}
