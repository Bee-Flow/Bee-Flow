/**
 * Typed views of the JavaScript the row browser calls. In a .js/.jsx module a
 * destructured prop without a default reads as required, and a `= null`
 * default as null-only, so these name the props and parameters the browser
 * actually passes; the modules themselves are untouched.
 */
import type { ComponentType } from 'react';
import type { DtColumn, DtTable, RowFilter } from './rowBrowserModel';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import RowCellEditorJs from '../../AppStudio/tables/RowCellEditor';
import { filterDescriptor as filterDescriptorJs, sourceErrorMessage as sourceErrorMessageJs } from '../datatableDisplay';

export const RowCellEditor = RowCellEditorJs as unknown as ComponentType<{
    field: DtColumn;
    value: unknown;
    onCommit: (value: unknown) => void;
    onCancel?: () => void;
    live?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
}>;

export { ColumnKindIcon } from '../ColumnKind';

/** Every answerable row of a filter draft, as the server's `filters` array. */
export const filterDescriptor = filterDescriptorJs as unknown as (rows: RowFilter[]) => RowFilter[];

/** The source's own words for a refused write, or '' / null when it has none. */
export const sourceErrorMessage = sourceErrorMessageJs as unknown as (t: TranslateFn, err: unknown, table?: DtTable | null) => string | null;
