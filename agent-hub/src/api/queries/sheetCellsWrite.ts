// PATCH a batch of cells of one sheet (the spreadsheet's debounced save). The
// active tab is named when there is one; without it the server writes the
// sheet's first tab. `keepalive` sends it as a request that outlives the page
// (the save while the page is being closed).

import { useMutation } from '@tanstack/react-query';
import { patchSheet } from '../sheetApi';

export interface SheetCellsBatch {
    documentId: string;
    cells: Record<string, string>;
    tabId: string | null;
    keepalive?: boolean;
}

export function useSheetCellsMutation() {
    return useMutation<unknown, Error, SheetCellsBatch>({
        mutationFn: ({ documentId, cells, tabId, keepalive }) => {
            if (keepalive) return patchSheet(documentId, cells, tabId || undefined, { keepalive: true });
            return tabId ? patchSheet(documentId, cells, tabId) : patchSheet(documentId, cells);
        },
    });
}
