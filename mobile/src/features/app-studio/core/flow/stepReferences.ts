/**
 * The things a step POINTS AT, by name rather than by id. Port of agent-hub
 * AppStudio/flow/stepReferences.js, pinned by stepReferences.lockstep.test.ts.
 *
 * A step field like tableId, modalId or automationId is a reference; a builder
 * picks it from a list and reads its name, never a raw `tbl_9f3a2c`. Lists the
 * editor cannot reach resolve to [] and every helper then degrades to the raw
 * id rather than to a blank, so a value is never hidden from whoever must fix it.
 *
 * The web's placeholder and empty-list sentences are Msg data here (core/msg).
 */

import { EN_ONLY, type Msg, type Translate } from '../msg';
import type { AppDefinition, AppNode } from '../types';

export type ReferenceKind = 'screen' | 'modal' | 'table' | 'dataset' | 'automation' | 'connector' | 'document';

/** Which reference a field key names. Keys are the STEP_SPECS field names. */
export const REFERENCE_FIELDS: Readonly<Record<string, ReferenceKind>> = {
    screenId: 'screen',
    modalId: 'modal',
    tableId: 'table',
    datasetId: 'dataset',
    automationId: 'automation',
    connectorId: 'connector',
    documentId: 'document',
};

const m = (key: string, en: string): Msg => ({ i18nKey: `mobile.app_studio.refs.${key}`, en });

/** What a picker shows when the field is not set yet. */
export const REFERENCE_PLACEHOLDERS: Readonly<Record<ReferenceKind, Msg>> = {
    screen: m('pick_screen', 'Pick a screen…'),
    modal: m('pick_modal', 'Pick a dialog…'),
    table: m('pick_table', 'Pick a table…'),
    dataset: m('pick_dataset', 'Pick a saved view…'),
    automation: m('pick_automation', 'Pick a routine…'),
    connector: m('pick_connector', 'Pick a connection…'),
    document: m('pick_document', 'Pick a document…'),
};

/** Why a list is empty, and what to do about it. */
export const REFERENCE_EMPTY_HINTS: Readonly<Record<ReferenceKind, Msg>> = {
    screen: m('empty_screen', 'This app has no other screens yet.'),
    modal: m('empty_modal', 'This app has no dialogs yet — add a Dialog component to a screen first.'),
    table: m('empty_table', 'This app has no tables yet — make one under Data first.'),
    dataset: m('empty_dataset', 'No saved views yet — save one from the query builder first.'),
    automation: m('empty_automation', 'No routines yet.'),
    connector: m('empty_connector', 'No connections yet — add one under Data · Connections first.'),
    document: m(
        'empty_document',
        'No designed documents yet — make the invoice, quote or letter in Studio → Documents first.',
    ),
};

export interface RefOption {
    id: string;
    label: string;
}

type Row = Record<string, unknown> | null | undefined;
const rows = (list: unknown): Row[] => (Array.isArray(list) ? (list as Row[]) : []);
const hasId = (r: Row): r is Record<string, unknown> & { id: string } => !!r && typeof r.id === 'string';
/** `a || b || c`: the first truthy value, else the last one. */
const firstText = (...values: unknown[]): string => (values.find((v) => v) ?? values[values.length - 1]) as string;

/** Documents as { id, label }; the placeholder count rides in the label. */
export function documentOptions(documents: unknown, t: Translate = EN_ONLY): RefOption[] {
    return rows(documents)
        .filter(hasId)
        .map((d) => {
            const count = (d.placeholders as { length?: number } | null | undefined)?.length;
            const label = count
                ? t('mobile.app_studio.refs.document_placeholders', '{name} · {count} placeholder(s)', {
                      name: String(d.name),
                      count: count as number,
                  })
                : (d.name as string);
            return { id: d.id, label };
        });
}

/** A dialog's own title, falling back to its id so it stays identifiable. */
function modalLabel(node: AppNode): string {
    const props = node?.props || {};
    const title = props.title || props.heading || props.label;
    return typeof title === 'string' && title.trim() ? title.trim() : node.id;
}

/** Every `modal` node in the app, in the order the screens list them. */
export function collectModals(definition: AppDefinition | null | undefined): RefOption[] {
    const out: RefOption[] = [];
    const walk = (nodes: AppNode[] | undefined) => {
        for (const n of nodes || []) {
            if (n?.type === 'modal' && typeof n.id === 'string') out.push({ id: n.id, label: modalLabel(n) });
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return out;
}

/** Screens as { id, label }. */
export function screenOptions(screens: unknown): RefOption[] {
    return rows(screens)
        .filter(hasId)
        .map((s) => ({ id: s.id, label: firstText(s.name, s.id) }));
}

/** Tables as { id, label }; a table may be addressed by `key`. */
export function tableOptions(tables: unknown): RefOption[] {
    return rows(tables)
        .filter((t) => !!t && (typeof t.id === 'string' || typeof t.key === 'string'))
        .map((t) => {
            const table = t as Record<string, unknown>;
            return { id: (table.id ?? table.key) as string, label: firstText(table.name, table.label, table.key, table.id) };
        });
}

/** Saved datasets as { id, label }. */
export function datasetOptions(datasets: unknown): RefOption[] {
    return rows(datasets)
        .filter(hasId)
        .map((d) => ({ id: d.id, label: firstText(d.name, d.title, d.id) }));
}

/** Routines as { id, label }. */
export function automationOptions(automations: unknown): RefOption[] {
    return rows(automations)
        .filter(hasId)
        .map((a) => ({ id: a.id, label: firstText(a.title, a.name, a.id) }));
}

/** Connectors as { id, label }. */
export function connectorOptions(connectors: unknown): RefOption[] {
    return rows(connectors)
        .filter(hasId)
        .map((c) => ({ id: c.id, label: firstText(c.name, c.kind, c.id) }));
}

/** The name behind an id, or the id itself when the list has not loaded or it is gone. */
export function labelForRef(options: unknown, id: unknown): string {
    if (id == null || id === '') return '';
    const hit = (Array.isArray(options) ? (options as RefOption[]) : []).find((o) => o.id === id);
    return hit ? hit.label : String(id);
}

/** Does this id point at nothing? Only once the list has actually loaded. */
export function isDanglingRef(options: unknown, id: unknown): boolean {
    if (id == null || id === '') return false;
    if (!Array.isArray(options) || options.length === 0) return false;
    return !(options as RefOption[]).some((o) => o.id === id);
}

export interface ColumnOption {
    key: string;
    label: string;
    type: string | null;
    required: boolean;
}

/** The columns of a table, keyed by the column the write is addressed by. */
export function columnOptions(fields: unknown): ColumnOption[] {
    return rows(fields)
        .filter((f): f is Record<string, unknown> & { key: string } => !!f && typeof f.key === 'string')
        .map((f) => ({
            key: f.key,
            label: firstText(f.name, f.key),
            type: (f.type as string) || null,
            required: !!f.required,
        }));
}
