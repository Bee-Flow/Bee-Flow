// PATCH a batch of cells of one sheet (the spreadsheet's debounced save). The
// active tab is named when there is one; without it the server writes the
// sheet's first tab.

import { useMutation } from '@tanstack/react-query';
import { patchSheet } from '../sheetApi';

export interface SheetCellsBatch {
    documentId: string;
    cells: Record<string, string>;
    tabId: string | null;
}

export function useSheetCellsMutation() {
    return useMutation<unknown, Error, SheetCellsBatch>({
        mutationFn: ({ documentId, cells, tabId }) => (tabId ? patchSheet(documentId, cells, tabId) : patchSheet(documentId, cells)),
    });
}
