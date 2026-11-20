// What a refused spreadsheet request means, in the reader's language. The
// server says WHY by code (server/routes/studioDocuments/sheet.js,
// server/core/documents/sheetCells.js); its own text is English and written
// for developers, so it is never shown, except for a storage limit, whose
// text the server already put in the reader's language.

import type { TranslateFn } from '@/hooks/useTranslation';

const BY_CODE: Record<string, [string, string]> = {
    document_read_only: ['doc_sheet.error.read_only', 'You can read this spreadsheet, but only its editors can change it.'],
    sheet_busy: ['doc_sheet.error.busy', 'Someone else is changing the same row right now. Try again in a moment.'],
    sheet_tab_not_found: ['doc_sheet.error.tab_not_found', 'This tab no longer exists. Reload the spreadsheet to see the tabs it has now.'],
    sheet_last_tab: ['doc_sheet.error.last_tab', 'A spreadsheet needs at least one tab, so the last one cannot be deleted.'],
    sheet_table_missing: ['doc_sheet.error.cells_missing', 'The cells of this spreadsheet are no longer there. They may have been deleted.'],
    sheet_not_found: ['doc_sheet.error.not_found', 'This spreadsheet no longer exists.'],
    sheet_write_too_large: ['doc_sheet.error.too_many_cells', 'Too many cells were changed at once. Change a smaller part at a time.'],
    sheet_cell_out_of_range: ['doc_sheet.error.out_of_range', 'A spreadsheet has columns A to Z and at most 2,000 rows. Some cells fall outside that.'],
    sheet_cell_too_long: ['doc_sheet.error.cell_too_long', 'A cell holds too much text. Shorten it and try again.'],
    usage_limit: ['doc_sheet.error.usage_limit', 'Your usage limit has been reached. Try again later or ask your administrator.'],
};

function codeOf(e: unknown): string | undefined {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}

/** The sentence for a refused request; `fallback` when the code says nothing a person can act on. */
export function sheetErrorText(e: unknown, t: TranslateFn, fallback: string): string {
    const code = codeOf(e);
    if (code === 'quota_exceeded' && e instanceof Error && e.message) return e.message;
    const known = code ? BY_CODE[code] : undefined;
    return known ? t(known[0], known[1]) : fallback;
}
