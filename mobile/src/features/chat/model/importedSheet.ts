/**
 * An uploaded workbook that the server imported as a spreadsheet document
 * (#164): the web opens it in the chat's side panel. The phone has no
 * spreadsheet editor (the Studio document screen edits text), so its chip
 * fetches the document as an Excel workbook (every tab, formulas and charts,
 * GET /api/studio-documents/:id/sheet.xlsx) and hands it to the share sheet,
 * where "open with" a spreadsheet app lives.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The route that builds the workbook from the stored cells. */
export function importedWorkbookPath(documentId: string): string {
    return `/api/studio-documents/${encodeURIComponent(documentId)}/sheet.xlsx`;
}

/** The upload's own name with an .xlsx extension (a .csv or .ods comes back as Excel). */
export function importedWorkbookName(name: string): string {
    const base = name.replace(/\.(xlsx|xlsm|xls|ods|csv|tsv)$/i, '').trim();
    return `${base || 'spreadsheet'}.xlsx`;
}
