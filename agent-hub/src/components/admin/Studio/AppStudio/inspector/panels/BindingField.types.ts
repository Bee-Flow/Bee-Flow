import type { ReactNode } from 'react';
import type { ChartMapping } from '../../bi/ChartDataPanel';
import type { BindingInput, PickSpec } from '../../runtime/resolveBinding.types';
import type { AppDefinition, AppNode, FormFieldRef } from '../appDefinition';
import type { DatasetGroup, DatasetAggregate } from '../../bi/useDatasets';
import type { LucideIcon } from 'lucide-react';
import type { ConnectorParamDecl } from '../../bi/useConnectors';

/** What the query builder hands back after saving a view. */
export interface BuiltView {
    datasetId: string;
    chart?: ChartMapping | null;
}

/**
 * Every field the binding editor reads or writes, across the kinds listed in the
 * header. A stored binding is loose data, so each reader below checks the shape it
 * needs (Array.isArray, typeof) before it uses a field.
 */
export interface BindingDraft {
    kind: string;
    value?: unknown;
    expr?: string;
    tableId?: string;
    datasetId?: string | null;
    connectorId?: string | null;
    actionId?: string | null;
    path?: string;
    filter?: unknown;
    sort?: unknown;
    limit?: number;
    groupBy?: Array<DatasetGroup | null>;
    aggregates?: Array<DatasetAggregate | null>;
    pick?: PickSpec | null;
    params?: Record<string, unknown>;
}

export interface SourceCardProps {
    choice: { kind: string; icon: LucideIcon; title: string; blurb: string };
    onPick: (kind: string) => void;
    disabled: boolean;
}

export interface SourceChooserProps {
    onPick: (kind: string) => void;
    onCancel: (() => void) | null;
    disabled: boolean;
}

export interface TableNameProps {
    appId: string | null;
    tableId: string;
}

export interface DatasetNameProps {
    appId: string | null;
    datasetId: string;
}

export interface ConnectorNameProps {
    appId: string | null;
    connectorId: string;
}

export interface NamedProps {
    appId: string | null;
    kind: string;
    id: string;
}

export interface SourceSentenceProps {
    binding: BindingDraft;
    appId: string | null;
}

export interface SourceSummaryProps {
    binding: BindingDraft;
    appId: string | null;
    onChangeClick: () => void;
    disabled: boolean;
}

/**
 * A count or a total, optionally split by a column.
 *
 * The "A count or total" card committed an `aggregate` binding and then nothing
 * rendered — no editor, and a summary sentence that called it "values typed in
 * here". So picking it was a dead end you could not even see you were in.
 *
 * The vocabulary (which functions, which date buckets) comes from QueryBuilder,
 * which already speaks it, rather than a second list that drifts.
 */
export interface AggregateBindingProps {
    binding: BindingDraft;
    onChange: (next: BindingDraft) => void;
    appId: string | null;
    disabled: boolean;
    definition: AppDefinition;
    node: AppNode | null;
    singleValue?: boolean;
}

export interface TableBindingProps {
    binding: BindingDraft;
    onChange: (next: BindingDraft) => void;
    appId: string | null;
    disabled: boolean;
    definition: AppDefinition;
    node: AppNode | null;
    singleValue?: boolean;
}

/**
 * Which ONE value a tile takes out of a view's answer table. Written as
 * `pick: { row, column }` on the binding; without it the tile would show the
 * whole answer instead of a single number.
 */
export interface PickValueFieldProps {
    pick?: PickSpec | null;
    columns: string[];
    onChange: (next: PickSpec) => void;
    disabled: boolean;
}

export interface DatasetBindingProps {
    binding: BindingDraft;
    onChange: (next: BindingDraft) => void;
    onBuild: ((built: { datasetId: string }) => void) | null;
    appId: string | null;
    componentType: string;
    singleValue: boolean;
    disabled: boolean;
}

export interface ConnectorParamFieldProps {
    param: ConnectorParamDecl;
    value: unknown;
    onChange: (next: unknown) => void;
    definition: AppDefinition;
    node: AppNode | null;
    disabled: boolean;
}

export interface ConnectorBindingProps {
    binding: BindingDraft;
    onChange: (next: BindingDraft) => void;
    appId: string | null;
    definition: AppDefinition;
    node: AppNode | null;
    disabled: boolean;
}

/** @param {import('./BindingField.types').BindingFieldProps} props */

export interface BindingFieldProps {
    label?: string | null;
    value?: unknown;
    onChange: (next: BindingDraft) => void;
    onBuild?: ((built: { datasetId: string }) => void) | null;
    definition: AppDefinition;
    node?: AppNode | null;
    componentType?: string;
    hint?: string | undefined;
    formFields?: FormFieldRef[];
    placeholder?: string | null;
    singleValue?: boolean;
    disabled?: boolean;
}
