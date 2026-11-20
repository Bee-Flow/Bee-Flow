// Adding categories to selected library rows. The bulk filing call takes one
// patch for all its rows, and a patch replaces a row's categories, so each row
// gets its own existing categories plus the new ones: rows that end up with
// the same list are filed together.

import type { LibraryRow, StudioDocument } from '../documentQueries';
import type { FilingResult } from './useLibrary';

type FilingInput = { rows: LibraryRow[]; patch: Pick<StudioDocument, 'categories'> };

/** "Sales, Q3" as categories: trimmed, no empties, no doubles. */
export function parseCategories(text: string): string[] {
    return [...new Set(text.split(',').map((x) => x.trim()).filter(Boolean))];
}

/** A row's categories with the new ones after them, each once. */
export function mergeCategories(existing: string[] | undefined, added: string[]): string[] {
    return [...new Set([...(existing || []), ...added])];
}

/** Add `added` to every row's own categories; a group the server refused as a whole counts as failed. */
export async function addCategories(rows: LibraryRow[], added: string[], run: (input: FilingInput) => Promise<FilingResult>): Promise<FilingResult> {
    const groups = new Map<string, FilingInput>();
    for (const row of rows) {
        const categories = mergeCategories(row.categories, added);
        const key = JSON.stringify(categories);
        const group = groups.get(key);
        if (group) group.rows.push(row);
        else groups.set(key, { rows: [row], patch: { categories } });
    }
    const result: FilingResult = { done: [], failed: [] };
    for (const group of groups.values()) {
        try {
            const part = await run(group);
            result.done.push(...part.done);
            result.failed.push(...part.failed);
        } catch {
            result.failed.push(...group.rows.map((r) => r.id));
        }
    }
    return result;
}
