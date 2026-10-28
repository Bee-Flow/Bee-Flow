import type { UpstreamNode } from '../../mapping/upstream/upstream.types';
import type { JsonValue, TableColumn, FeedGroup } from './tablesRowValues';
import type { UpstreamGroup } from '../../mapping/deepFields';
import type { OnFocusField } from '../../mapping/focusField.types';
import type { Binding } from '../../mapping/itemRefs';
import type { TranslateParams } from '@/hooks/useTranslation';
import type React from 'react';

export interface TablesRowValuesEditorProps {
    step?: Pick<UpstreamNode, 'tool' | 'forEach'> | null;
    tool?: string | null;
    value?: JsonValue;
    onChange?: (next: unknown) => void;
    catalog?: unknown;
    groups?: UpstreamGroup[] | null;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    tableId: Binding | null | undefined;
    loadColumns?: (tableId: string | number) => Promise<TableColumn[]>;
    allowRaw?: boolean;
}

/**
 * "Auto-map": fill the EMPTY columns from one upstream group by normalised
 * name — columnMatch.matchColumns, nothing looser — and say what happened.
 * The source defaults to the group the row is fed by (the step's forEach item,
 * else the nearest step) and can be pointed elsewhere.
 */
export interface AutoMapProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    step: Pick<UpstreamNode, 'tool' | 'forEach'> | null;
    upstream: UpstreamGroup[];
    columns: TableColumn[];
    map: Record<string, unknown>;
    cellBinding: (col: TableColumn) => Binding | undefined;
    emit: (next: Record<string, unknown>) => void;
}

/** An upstream group the Auto-map source menu offers: its id and label come from the picker's groups. */
export type SourceGroup = FeedGroup & { id?: string; label?: string };

export interface TypeBadgeProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    col: TableColumn;
}

/** One column: title · Required · type badge · hint, and the value slot. */
export interface ColumnRowProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    col: TableColumn;
    typed: boolean;
    required: boolean;
    value: Binding | null | undefined;
    onChange: (binding: unknown) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    allowRaw: boolean;
}

/** The typed-titles fallback: one box, comma-separated, Enter or the button adds. */
export interface ManualTitlesProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    onAdd: (titles: string[]) => void;
}

/** Keys that reach no column of this table: shown by name, editable, removable — never dropped. */
export interface StrayKeysProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    keys: string[];
    map: Record<string, unknown>;
    onRemove: (key: string) => void;
    onChange: (key: string, binding: unknown) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    allowRaw: boolean;
}

/**
 * The whole map bound from one place (`{kind:'ref', path:'steps.x.output.row'}`)
 * — there are no columns to draw, so the binding is shown as one slot with a
 * way back to filling the columns one by one.
 */
export interface WholeRowSlotProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    value: Binding | null;
    onChange?: (binding: unknown) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    allowRaw: boolean;
    onSplit: React.MouseEventHandler<HTMLButtonElement>;
}
