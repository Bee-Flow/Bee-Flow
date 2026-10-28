import { useMemo } from 'react';
import { useTablePreview, type TablePreviewState } from '@/hooks/automationBuilder/useTablePreview';
import type { TableColumn } from '@/api/queries/automation/runTables';
import type { DescribedColumn, Finding, OpResult, PreviewFn, PreviewSource, TablePreviewResponse } from '@/api/queries/automation/tablePreview';
import { walkPath } from '@/utils/bindingHelpers';
import {
    columnsInto, columnsOf, handleFromBinding, issuesOf, sampleRowOf,
    type Binding, type FieldIssue, type TableOp,
} from './tableOpModel';

/** Asked once per table, to learn what its columns hold (choices, numbers, personal data). */
const DESCRIBE_OP = { id: 'describe', op: 'describe', enabled: true, columns: null, maxOptions: 20, sampleValues: 0 };

export interface TableEditorData {
    /** The table of the last run the source points at; null when no run has made it. */
    sourceRef: PreviewSource | null;
    /** Its columns, known even from a dry run. */
    sourceColumns: TableColumn[] | null;
    sourceRow: Record<string, unknown> | null;
    preview: TablePreviewState;
    described: ReadonlyMap<string, DescribedColumn>;
    opResults: readonly OpResult[];
    findings: readonly Finding[];
    /** Per operation, what the preview says about it. */
    issues: (FieldIssue & { rest: string })[][];
    /** Ids of the operations the preview has an error for. */
    problems: ReadonlySet<string>;
    columnsInto: (index: number) => TableColumn[] | null;
    otherColumns: (op: TableOp) => TableColumn[] | null;
}

interface Args {
    automationId: string | null | undefined;
    source: Binding | null;
    ops: TableOp[];
    /** The operation the preview stops at; null for the whole step. */
    upToOpId: string | null;
    previewSample: unknown;
    preview?: PreviewFn;
}

const EMPTY_RESULTS: readonly OpResult[] = [];
const EMPTY_FINDINGS: readonly Finding[] = [];

interface Sources {
    sourceRef: PreviewSource | null;
    columns: TableColumn[] | null;
    row: Record<string, unknown> | null;
    joinSources: Record<string, PreviewSource>;
    others: Map<string, TableColumn[] | null>;
}

/** The tables the step reads, found in the editor's sample of the last run. */
function findSources(source: Binding | null, ops: TableOp[], sample: unknown): Sources {
    const resolve = (path: string) => walkPath(path, sample);
    const pathValue = (b: Binding | null | undefined) => (b && b.kind === 'ref' && b.path ? resolve(b.path) : undefined);
    const value = pathValue(source);
    const handle = handleFromBinding(source, resolve);
    const joinSources: Record<string, PreviewSource> = {};
    const others = new Map<string, TableColumn[] | null>();
    for (const op of ops) {
        if (op.op !== 'join' || !op.with) continue;
        const h = handleFromBinding(op.with, resolve);
        if (h && op.enabled) joinSources[op.id] = { runId: h.runId, tableId: h.tableId };
        others.set(op.id, columnsOf(pathValue(op.with)));
    }
    return {
        sourceRef: handle ? { runId: handle.runId, tableId: handle.tableId } : null,
        columns: columnsOf(value) ?? handle?.columns ?? null,
        row: sampleRowOf(value),
        joinSources,
        others,
    };
}

/** What the sample says about the columns, the source's first and the result's over it. */
function describedColumns(...responses: (TablePreviewResponse | null)[]): Map<string, DescribedColumn> {
    const map = new Map<string, DescribedColumn>();
    for (const r of responses) {
        if (r && r.ok && r.description) for (const c of r.description.columns) map.set(c.key, c);
    }
    return map;
}

/**
 * Everything the Edit table editor learns from the last run and from the
 * preview: the table to work on, its columns, what they hold, and what each
 * step did. The preview goes to the server for this editor only.
 */
export function useTableEditorData({ automationId, source, ops, upToOpId, previewSample, preview }: Args): TableEditorData {
    const found = findSources(source, ops, previewSample);
    const main = useTablePreview({ automationId, source: found.sourceRef, ops, upToOpId, joinSources: found.joinSources, preview });
    const what = useTablePreview({ automationId, source: found.sourceRef, ops: [DESCRIBE_OP], limit: 1, preview });
    const response = main.response;
    const opResults = response?.opResults ?? EMPTY_RESULTS;
    const findings = response && !response.ok ? response.findings : EMPTY_FINDINGS;
    const described = useMemo(() => describedColumns(what.response, response), [what.response, response]);
    const issues = ops.map((op, i) => issuesOf(i, op.id, findings, opResults));
    return {
        sourceRef: found.sourceRef,
        sourceColumns: found.columns,
        sourceRow: found.row,
        preview: main,
        described,
        opResults,
        findings,
        issues,
        problems: new Set(ops.filter((_, i) => issues[i].some(x => x.severity === 'error')).map(o => o.id)),
        columnsInto: index => columnsInto(found.columns, ops, index, opResults, id => found.others.get(id) ?? null),
        otherColumns: op => found.others.get(op.id) ?? null,
    };
}
