/** React Query keys for notebooks, under the Library tab's 'library' prefix. */

export const notebookKeys = {
    /** Every list query, the hub's and the list screen's. */
    all: ['library', 'notebooks'] as const,
    /** The hub's page, server-searched by `term`. */
    search: (term: string) => ['library', 'notebooks', term] as const,
    /** The list screen's page: the same prefix, plus its filter chip. */
    list: (term: string, filter: string) => ['library', 'notebooks', term, filter] as const,
    detail: (id: string) => ['library', 'notebook', id] as const,
    conversation: (id: string) => ['library', 'notebook', id, 'conversation'] as const,
    sourceContent: (id: string, sourceId: string) => ['library', 'notebook', id, 'source', sourceId] as const,
};
