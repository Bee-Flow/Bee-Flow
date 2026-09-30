/**
 * React Query keys for forms, under the published-surfaces 'publishing'
 * prefix. `all` is the org-wide list; everything about one form hangs off it,
 * so invalidating `all` refreshes the list and every open Form page.
 */

export const formKeys = {
    all: ['publishing', 'forms'] as const,
    /** One form's Form page (GET /forms/:automationId), keyed by the ROUTINE. */
    detail: (automationId: string) => ['publishing', 'forms', 'detail', automationId] as const,
    /** The device's per-user "opened at" map (model/recents.ts). */
    recents: (userId: string) => ['publishing', 'form-recents', userId] as const,
    /** An answers table's dashboard, per period. */
    answers: (datatableId: string) => ['publishing', 'form-answers', datatableId] as const,
    answersSummary: (datatableId: string, from: string | null, to: string | null) =>
        ['publishing', 'form-answers', datatableId, 'summary', from ?? '', to ?? ''] as const,
    answerRows: (datatableId: string, focus: string | null) => ['publishing', 'form-answers', datatableId, 'rows', focus ?? ''] as const,
    answerRow: (datatableId: string, rowId: string) => ['publishing', 'form-answers', datatableId, 'row', rowId] as const,
};
