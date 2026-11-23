// What tells two documents with the same name apart in a picker: copies made
// from one starter ("Quote", "Quote", "Quote") were indistinguishable options.

interface NamedDocument {
    id: string;
    name?: string;
    updatedAt?: string;
}

/**
 * ` · 23 Nov, 17:22` (when it was last changed) for a document whose name
 * another one in the list shares; '' for a unique name.
 */
export function duplicateNameSuffix(doc: NamedDocument, all: readonly NamedDocument[], locale?: string | null): string {
    const name = (doc.name || '').trim();
    if (!all.some((other) => other.id !== doc.id && (other.name || '').trim() === name)) return '';
    const when = doc.updatedAt ? new Date(doc.updatedAt) : null;
    if (!when || Number.isNaN(when.getTime())) return '';
    let text: string;
    try {
        text = new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(when);
    } catch {
        text = when.toISOString().slice(0, 16).replace('T', ' ');
    }
    return ` · ${text}`;
}
