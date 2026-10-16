// The shared DataTable, re-exported for the project content tables under the
// names they use. DataTable.tsx types its own props and columns.

import DataTableJs, { TableCell as TableCellJs, TableRow as TableRowJs } from '../../../shared/DataTable';

export type { TableColumn } from '../../../shared/DataTable';

export const DataTable = DataTableJs;
export const TableRow = TableRowJs;
export const TableCell = TableCellJs;
