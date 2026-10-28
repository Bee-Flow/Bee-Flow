import { LimitFields, DedupeFields, AggregateFields, SummarizeFields } from './collectionEditors';
import { Suspense } from 'react';
import { lazyWithI18n } from '@/utils/lazyWithReload';

// The table editors are large and only the table steps need them: keep them out of the entry chunks.
const ReadTableFields = lazyWithI18n(() => import('./tableEditor/ReadTableFields'));
const TableFields = lazyWithI18n(() => import('./tableEditor/TableFields'));

/** The step types this dispatcher answers for. */
export const DATA_STEP_TYPES: ReadonlySet<string> = new Set(['limit', 'dedupe', 'aggregate', 'summarize', 'read_table', 'table']);

interface Props {
    step: { id: string; type: string };
    draft: unknown;
    set: (key: string, value: unknown) => void;
    groups?: unknown[];
    onFocusField?: unknown;
    previewSample?: unknown;
    errorSections?: Set<string>;
    /** The automation being edited: the table preview asks the server about it. */
    automationId?: string | null;
}

/**
 * The settings of the steps that work on a list or a table and share one prop
 * shape (limit, dedupe, aggregate, summarize, read_table, table). One dispatcher
 * so the settings form does not grow a branch for each of them.
 */
export default function DataStepFields({ step, draft, set, groups, onFocusField, previewSample, errorSections, automationId }: Props) {
    // Each editor types its own draft; the settings form hands every one of them the draft it extracted for this step.
    const d = draft as never;
    const common = { draft: d, set, groups: groups as never, onFocusField: onFocusField as never, previewSample: previewSample as never, errorSections: errorSections as never };
    switch (step.type) {
        case 'limit': return <LimitFields {...common} />;
        case 'dedupe': return <DedupeFields {...common} />;
        case 'aggregate': return <AggregateFields {...common} />;
        case 'summarize': return <SummarizeFields {...common} />;
        case 'read_table': return <Suspense fallback={null}><ReadTableFields {...common} stepId={step.id} /></Suspense>;
        case 'table': return <Suspense fallback={null}><TableFields {...common} automationId={automationId ?? null} /></Suspense>;
        default: return null;
    }
}
