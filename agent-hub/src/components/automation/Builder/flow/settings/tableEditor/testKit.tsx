import { useState, type ReactNode } from 'react';
import type { TableColumn } from '../../../../../../api/queries/automation/runTables';
import type { OpResult, PreviewFn, TablePreviewOk, TablePreviewResponse } from '../../../../../../api/queries/automation/tablePreview';
import { VariablePickerProvider } from '../../../mapping/VariablePickerContext';
import TableFields from './TableFields';
import { newOp, type Binding, type TableOp } from './tableOpModel';

/** Made-up tables for the editor's tests. */
export const col = (key: string, type: TableColumn['type'] = 'text'): TableColumn => ({ key, label: key, type });

export const COLUMNS = [col('Region'), col('Amount', 'number'), col('Email')];

export const HANDLE = {
    kind: 'table', tableId: `rtb_${'a'.repeat(32)}`, runId: 'run1', name: 'Sheet1', columns: COLUMNS, rowCount: 50,
    preview: [{ Region: 'North', Amount: 10, Email: 'a@example.test' }], expiresAt: null, provenance: null,
};

export const SAMPLE = { steps: { s1: { output: { table: HANDLE, tables: [HANDLE], tablesByName: { Sheet1: HANDLE }, sheets: [{ name: 'Sheet1' }, { name: 'Notes' }] } } } };

export const GROUPS = [{
    id: 's1', label: 'Read table', kind: 'read_table', basePath: 'steps.s1.output', sample: SAMPLE.steps.s1.output, fields: [],
}];

export const SOURCE: Binding = { kind: 'ref', path: 'steps.s1.output.table' };

export const op = (kind: Parameters<typeof newOp>[0], id: string, extra: Record<string, unknown> = {}): TableOp =>
    ({ ...newOp(kind, []), id, ...extra }) as TableOp;

export const okResponse = (extra: Partial<TablePreviewOk> = {}): TablePreviewOk => ({
    ok: true, columns: COLUMNS, rows: [{ Region: 'North', Amount: 10, Email: 'a@example.test' }], rowCount: 1, inputRows: 50, inputCapped: false,
    description: null, segments: null, opResults: [], warnings: [], ...extra,
});

export const opResult = (opId: string, columns: string[], extra: Partial<OpResult> = {}): OpResult =>
    ({ opId, op: 'filter', enabled: true, ok: true, inputRows: 50, outputRows: 20, columns, warnings: [], ...extra });

/** A fake server: answers every preview with the given response and remembers what it was asked. */
export function fakePreview(answer: TablePreviewResponse | ((body: Parameters<PreviewFn>[1]) => TablePreviewResponse) = okResponse()) {
    const calls: Parameters<PreviewFn>[1][] = [];
    const fn: PreviewFn = async (_id, body) => {
        calls.push(body);
        return typeof answer === 'function' ? answer(body) : answer;
    };
    return { fn, calls };
}

interface HarnessProps {
    initial: { source: Binding | null; ops: TableOp[]; name?: string; expiresInDays?: number };
    preview: PreviewFn;
    sample?: unknown;
    groups?: typeof GROUPS;
    onDraft?: (draft: Record<string, unknown>) => void;
    children?: ReactNode;
}

/** The editor with a draft of its own, the way the settings form holds one. */
export function TableHarness({ initial, preview, sample = SAMPLE, groups = GROUPS, onDraft }: HarnessProps) {
    const [draft, setDraft] = useState({ name: '', expiresInDays: 7, ...initial });
    const set = (key: string, value: unknown) => setDraft(d => {
        const next = { ...d, [key]: value };
        onDraft?.(next);
        return next;
    });
    return (
        <VariablePickerProvider groups={groups as never} previewSample={sample} stepLabelById={new Map([['s1', 'Read table']])}>
            <TableFields draft={draft} set={set} groups={groups} previewSample={sample} automationId="auto1" preview={preview} />
        </VariablePickerProvider>
    );
}
