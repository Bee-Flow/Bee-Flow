// The library's reads and writes: which page of which list is shown, and the
// actions on it (create, copy, archive, restore, move, categorise, folders).
// Every write refreshes the library's cached lists; the list on screen stays
// put while the next one loads.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { createDocument, createSpreadsheet, deleteDocument, documentRequest, unarchiveDocument, updateDocument } from '../documentsApi';
import { notebookApi } from '../../notebooks/hooks/notebookApi';
import { docKeys, type LibraryFilters, type LibraryRow, type StudioDocument } from '../documentQueries';

export const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

export type LibraryKind = LibraryFilters['kind'];
/** '' every type; 'page' pages; 'designed' designed documents; 'presentation' decks; 'notebook' notebooks; 'spreadsheet' sheets. */
export type LibraryFormat = '' | 'page' | 'designed' | 'presentation' | 'notebook' | 'spreadsheet';

/** A library row that is a notebook (its content lives behind /api/notebooks). */
export const isNotebookRow = (row: Pick<LibraryRow, 'docType'>) => row.docType === 'notebook';

/**
 * Whether a type filter means anything in a view. Templates and reusable
 * sections are designed documents or decks, so no page or notebook is one; a
 * notebook is never archived (deleting one is for good).
 */
export function formatApplies(format: LibraryFormat, kind: LibraryKind, archived: boolean): boolean {
    if (format === 'notebook') return kind === 'document' && !archived;
    // A page or a spreadsheet is never a template or a section.
    if (format === 'page' || format === 'spreadsheet') return kind === 'document';
    return true;
}

export function useLibraryFilters() {
    const [kind, setKind] = useState<LibraryKind>('document');
    const [archived, setArchived] = useState(false);
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [folderId, setFolderId] = useState<string | undefined>(undefined);
    const [visibility, setVisibility] = useState('');
    const [format, setFormat] = useState<LibraryFormat>('');
    const [category, setCategory] = useState('');
    const [sort, setSort] = useState<'updated' | 'name'>('updated');
    const [offset, setOffset] = useState(0);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);
    // Another filter is another list: back to its first page.
    useEffect(() => { setOffset(0); }, [kind, archived, debounced, folderId, visibility, format, category, sort]);

    const filters = useMemo<LibraryFilters>(() => ({
        kind, archived, query: debounced || undefined, folderId, category: category.trim() || undefined,
        // A type that does not apply to this view is no filter (its pill is not shown).
        visibility: visibility || undefined, docType: (formatApplies(format, kind, archived) && format) || undefined, sort, offset, limit: PAGE_SIZE,
    }), [kind, archived, debounced, folderId, category, visibility, format, sort, offset]);

    return {
        filters, kind, setKind, archived, setArchived, query, setQuery, folderId, setFolderId, visibility, setVisibility,
        format, setFormat, category, setCategory, sort, setSort, offset, setOffset,
    };
}

export interface NewDocumentInput { name: string; docType?: string; starterId?: string; bodyHtml?: string; css?: string; locale?: string; kind: LibraryKind; folderId?: string }

export function useLibraryActions() {
    const qc = useQueryClient();
    const refresh = () => qc.invalidateQueries({ queryKey: docKeys.all });
    const create = useMutation({
        mutationFn: (input: NewDocumentInput) => createDocument(input) as Promise<StudioDocument>,
        onSuccess: refresh,
    });
    const duplicate = useMutation({
        mutationFn: async (id: string) => ((await documentRequest(`/${encodeURIComponent(id)}/duplicate`, { kind: 'document' })) as { document: StudioDocument }).document,
        onSuccess: refresh,
    });
    const archive = useMutation({ mutationFn: (id: string) => deleteDocument(id) as Promise<boolean>, onSuccess: refresh });
    const unarchive = useMutation({ mutationFn: (id: string) => unarchiveDocument(id) as Promise<StudioDocument>, onSuccess: refresh });
    const bulk = useMutation({
        // One after another: each is its own revision check. A notebook is
        // filed through its own route (no revision: filing is not an edit).
        mutationFn: async ({ rows, patch }: { rows: LibraryRow[]; patch: Pick<StudioDocument, 'folderId' | 'categories'> }) => {
            for (const row of rows) {
                if (isNotebookRow(row)) await documentRequest(`/notebooks/${encodeURIComponent(row.id)}/filing`, patch, 'PATCH');
                else await updateDocument(row.id, { ...patch, expectedVersionId: row.versionId });
            }
        },
        onSettled: refresh,
    });
    // A notebook: made in the folder the library shows, deleted for good (a
    // notebook has no archive; the confirmation says so).
    const createNotebook = useMutation({
        mutationFn: async ({ name, folderId }: { name: string; folderId?: string }) => {
            const { notebook } = (await notebookApi('/', { method: 'POST', body: JSON.stringify({ name }) })) as { notebook: { id: string } };
            if (folderId) await documentRequest(`/notebooks/${encodeURIComponent(notebook.id)}/filing`, { folderId }, 'PATCH').catch(() => undefined);
            return notebook;
        },
        onSuccess: refresh,
    });
    const createSheet = useMutation({
        mutationFn: (input: { name: string; folderId?: string }) => createSpreadsheet(input) as Promise<StudioDocument>,
        onSuccess: refresh,
    });
    const deleteNotebook = useMutation({
        mutationFn: (id: string) => notebookApi(`/${encodeURIComponent(id)}`, { method: 'DELETE' }) as Promise<unknown>,
        onSuccess: refresh,
    });
    const createFolder = useMutation({
        mutationFn: ({ name, parentId }: { name: string; parentId: string | null }) => documentRequest('/folders', { name, parentId }),
        onSuccess: refresh,
    });
    const deleteFolder = useMutation({
        mutationFn: (id: string) => documentRequest(`/folders/${encodeURIComponent(id)}`, undefined, 'DELETE'),
        onSuccess: refresh,
    });
    return { create, createNotebook, createSheet, duplicate, archive, unarchive, deleteNotebook, bulk, createFolder, deleteFolder };
}
