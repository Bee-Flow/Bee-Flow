/**
 * The hub's search: one ranked list across all four collections, with the
 * kind shown as a badge. Notebooks are searched on the SERVER (the route
 * whitelists `search` and pages the result), so every notebook row that came
 * back is already a match; the other three collections are fully loaded for
 * the hub anyway, so they are filtered here.
 */

import { timeAgo } from '@/core/i18n';
import type { OwnedDocument } from '@/features/documents';
import type { KnowledgeBase } from '@/features/knowledge';
import type { NotebookCard } from '@/features/notebooks';
import type { Template } from '@/features/templates';
import { plural } from '@/shared/lib/format';
import type { IconName } from '@/shared/ui';

import type { LibraryHit } from './types';

export interface HubCollections {
    notebooks: NotebookCard[];
    bases: KnowledgeBase[];
    documents: OwnedDocument[];
    templates: Template[];
}

export const KIND_ICON: Record<LibraryHit['kind'], IconName> = {
    notebook: 'Book',
    knowledge: 'Database',
    document: 'FileText',
    template: 'PanelsTopLeft',
};

export const KIND_LABEL: Record<LibraryHit['kind'], string> = {
    notebook: 'Notebook',
    knowledge: 'Knowledge',
    document: 'Document',
    template: 'Template',
};

const notebookHit = (nb: NotebookCard): LibraryHit => ({
    kind: 'notebook',
    id: nb.id,
    title: nb.name,
    subtitle: nb.description || nb.preview || undefined,
    meta: timeAgo(nb.lastActivityAt ?? nb.updatedAt),
    href: `/notebooks/${nb.id}`,
});

const baseHit = (kb: KnowledgeBase): LibraryHit => ({
    kind: 'knowledge',
    id: kb.id,
    title: kb.name,
    subtitle: kb.description || undefined,
    meta: `${Number(kb.document_count ?? 0)} docs`,
    href: `/knowledge/${kb.id}`,
});

const documentHit = (doc: OwnedDocument): LibraryHit => ({
    kind: 'document',
    id: doc.id,
    title: doc.title || 'Untitled document',
    subtitle: doc.kbName,
    meta: timeAgo(doc.created_at),
    href: `/knowledge/${doc.kbId}`,
});

const templateHit = (t: Template): LibraryHit => ({
    kind: 'template',
    id: t.id,
    title: t.name,
    subtitle: t.description || undefined,
    meta: plural(t.parameters.length, 'field'),
    href: '/templates',
});

/** Every hit for `term`, notebooks first. Nothing when the box is empty. */
export function buildHits(term: string, data: HubCollections): LibraryHit[] {
    if (!term) return [];
    const needle = term.toLowerCase();
    const matches = (...fields: (string | null | undefined)[]) =>
        fields.some((f) => (f ?? '').toLowerCase().includes(needle));

    return [
        ...data.notebooks.map(notebookHit),
        ...data.bases.filter((kb) => matches(kb.name, kb.description)).map(baseHit),
        ...data.documents.filter((doc) => matches(doc.title, doc.source_uri)).map(documentHit),
        ...data.templates.filter((t) => matches(t.name, t.description)).map(templateHit),
    ];
}
