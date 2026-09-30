/**
 * Counts on the knowledge rows: one is singular ("1 document", not "1 docs"),
 * and what the index calls a chunk is said as the web says what search finds —
 * a passage.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { KbDocumentRow } from './KbDocumentRow';
import { KnowledgeBaseRow } from './KnowledgeBaseRow';
import type { KbDocument, KnowledgeBase } from '../model/types';

const kb = (over: Partial<KnowledgeBase>): KnowledgeBase => ({
    id: 'kb1',
    tenant_id: 't1',
    name: 'Price list',
    description: null,
    organization_id: null,
    category_id: null,
    icon: null,
    is_published: true,
    created_at: '2026-09-01T10:00:00Z',
    ...over,
});

const doc = (chunks: number) =>
    ({
        id: 'd1',
        tenant_id: 't1',
        knowledge_base_id: 'kb1',
        title: 'Prices 2026',
        source_type: 'upload',
        source_uri: null,
        lang: null,
        content_hash: null,
        chunk_count: chunks,
        created_at: '2026-09-01T10:00:00Z',
    }) as KbDocument;

const noop = () => undefined;

describe('KnowledgeBaseRow', () => {
    it('counts one document and one passage in the singular', async () => {
        await renderWithProviders(<KnowledgeBaseRow kb={kb({ document_count: 1, total_chunks: 1 })} favorite={false} onPress={noop} onLongPress={noop} />);
        expect(screen.getByText('1 document · 1 passage')).toBeTruthy();
    });

    it('counts several in the plural', async () => {
        await renderWithProviders(<KnowledgeBaseRow kb={kb({ document_count: 3, total_chunks: 40 })} favorite={false} onPress={noop} onLongPress={noop} />);
        expect(screen.getByText('3 documents · 40 passages')).toBeTruthy();
    });
});

describe('KbDocumentRow', () => {
    it('says one passage, not "1 chunks"', async () => {
        await renderWithProviders(<KbDocumentRow doc={doc(1)} onPress={noop} onLongPress={noop} />);
        expect(screen.getByText('1 passage')).toBeTruthy();
    });

    it('says several passages', async () => {
        await renderWithProviders(<KbDocumentRow doc={doc(4)} onPress={noop} onLongPress={noop} />);
        expect(screen.getByText('4 passages')).toBeTruthy();
    });
});
