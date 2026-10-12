/**
 * Handing a form result to the visitor as a file (BFSF-419). Kept out of
 * PublicFormRenderer.jsx so that file exports only components.
 */

/**
 * A safe, boring filename from the closing page's own title. Same rule as the
 * server's resultFilename (server/automation/formResult.js), so a .txt and a
 * .docx of one result carry the same name.
 */
export function resultFilename(title: string | null | undefined, extension: string): string {
    const base = String(title || 'result').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${base || 'result'}.${extension}`;
}

/**
 * Hand the visitor a Blob as a file. A Blob + object URL, same as every other
 * export-to-file button on this stack (RowBrowser's CSV export, the CMS page
 * export) — never an `<a href>` at a real endpoint, which carries no auth
 * header and turns an error answer into a downloaded file.
 */
export function saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
