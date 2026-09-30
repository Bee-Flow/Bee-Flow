/**
 * The Indexed tab's data: the bases, the ones the chip row narrows to, the
 * documents fanned out over them, and the search applied on top.
 */

import { useMemo } from 'react';

import { useKnowledgeBases } from '@/features/knowledge';

import { useDocumentsAcross } from './queries';
import type { OwnedDocument } from '../model/types';

function matches(doc: OwnedDocument, needle: string): boolean {
    return (
        (doc.title ?? '').toLowerCase().includes(needle) ||
        (doc.source_uri ?? '').toLowerCase().includes(needle) ||
        doc.kbName.toLowerCase().includes(needle)
    );
}

export function useIndexedDocuments(filterKbId: string | null, search: string) {
    const bases = useKnowledgeBases();

    const scopedBases = useMemo(() => {
        const all = bases.data ?? [];
        return filterKbId ? all.filter((kb) => kb.id === filterKbId) : all;
    }, [bases.data, filterKbId]);

    const indexed = useDocumentsAcross('all', scopedBases, { enabled: bases.isSuccess });

    const documents = useMemo(() => {
        const all = indexed.data?.documents ?? [];
        const needle = search.trim().toLowerCase();
        return needle ? all.filter((doc) => matches(doc, needle)) : all;
    }, [indexed.data, search]);

    return { bases, scopedBases, indexed, documents };
}
