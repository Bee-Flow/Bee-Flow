// A notebook is a document type, but its id is a notebook's (the notebook
// tables keep its content, sources and chat). The Documents section tells the
// two apart by a prefix on the open item: `notebook/<id>`, which is also its
// URL under Studio (`/app/studio/documents/notebook/<id>`). Kept free of
// imports: AgentHub reads it on the main chunk.

const PREFIX = 'notebook/';

/** The open-item reference of a notebook in the Documents section. */
export function notebookRef(id: string): string {
    return PREFIX + id;
}

/** The notebook id in a reference, or null when it names a document. */
export function notebookIdOf(ref: string | null | undefined): string | null {
    return ref && ref.startsWith(PREFIX) && ref.length > PREFIX.length ? ref.slice(PREFIX.length) : null;
}

/** What the Documents section opens for a parsed Studio route. */
export function documentRefOf(route: { id?: string | null; sub?: string | null }): string | null {
    if (route.id === 'notebook') return route.sub ? notebookRef(route.sub) : null;
    return route.id || null;
}
