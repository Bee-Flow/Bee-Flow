/** What a GET answer for an automation (or a step) carries around its row. */
export interface RowAnswer {
    automation?: Record<string, unknown>;
    step?: Record<string, unknown>;
    managed?: unknown;
    [key: string]: unknown;
}

/**
 * The row out of a GET answer. `managed` sits BESIDE the row ({ automation,
 * summary, managed }); it is carried onto the row so the header and the
 * read-only switch see it wherever they read the automation from.
 */
export function unwrapRow(r: RowAnswer | null | undefined): Record<string, unknown> | RowAnswer | null | undefined {
    const row = (r && (r.automation || r.step)) || r;
    return row && r && r.automation && r.managed !== undefined ? { ...row, managed: r.managed } : row;
}
