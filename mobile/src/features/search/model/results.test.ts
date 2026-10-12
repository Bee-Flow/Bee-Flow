/**
 * buildResults, group by group: what each wire row becomes, the limits, and
 * the rules that are easy to break — a passage joined back to its base, a
 * passage that cannot be joined shown without a dead tap, the two document
 * directions deduplicated, Steps kept out of automations, and each group's error
 * travelling with it instead of emptying the list.
 */

import { buildAccessSnapshot } from '@/core/access';

import { buildResults, EMPTY_CORPUS, EMPTY_MATCHES } from './results';
import type { CorpusDocument, SearchCorpus, SearchGroupKey, ServerMatches } from './types';

const NOBODY = buildAccessSnapshot({ user: null, permissions: null });

function group(key: SearchGroupKey, corpus: SearchCorpus, found: ServerMatches, term = 'invoice') {
    return buildResults(term, corpus, found, NOBODY).groups.find((g) => g.key === key);
}

const DOC: CorpusDocument = {
    id: 'D1',
    knowledge_base_id: 'kb1',
    title: 'Invoice policy',
    source_type: 'file',
    source_uri: null,
    chunk_count: 1,
    created_at: '2026-09-01T00:00:00Z',
    kbName: 'Finance',
};

describe('buildResults', () => {
    it('keeps the fixed group order and counts every hit', () => {
        const results = buildResults('invoice', EMPTY_CORPUS, EMPTY_MATCHES, NOBODY);
        expect(results.groups.map((g) => g.key)).toEqual([
            'places',
            'chats',
            'notebooks',
            'documents',
            'knowledge',
            'automations',
            'transcripts',
        ]);
        expect(results.total).toBe(results.groups.reduce((n, g) => n + g.hits.length, 0));
    });

    it('opens direct chats and says an agent chat lives on the web', () => {
        const hits = group('chats', EMPTY_CORPUS, {
            ...EMPTY_MATCHES,
            chats: [
                { id: 'c1', title: null, updated_at: '', kind: 'direct' },
                { id: 'c2', title: 'Budget', updated_at: '', kind: 'agent', agent_name: 'Finance bot' },
            ],
        })?.hits;
        expect(hits?.[0]).toMatchObject({ title: 'Untitled chat', subtitle: 'Matched in the title', href: '/chat/c1' });
        expect(hits?.[1]).toMatchObject({ subtitle: 'Finance bot · matched in the title', href: null });
    });

    it('describes a notebook by its matching text, else by its sources', () => {
        const hits = group('notebooks', EMPTY_CORPUS, {
            ...EMPTY_MATCHES,
            notebooks: [
                { id: 'n1', name: 'Q3', description: 'All about the invoice run', preview: '', sourceCount: 2, lastActivityAt: null, updatedAt: null },
                { id: 'n2', name: '', description: '', preview: '', sourceCount: 1, lastActivityAt: null, updatedAt: null },
            ],
        })?.hits;
        expect(hits?.[0]?.subtitle).toContain('invoice run');
        expect(hits?.[1]).toMatchObject({ title: 'Untitled notebook', subtitle: '1 source', href: '/notebooks/n2' });
    });

    it('joins a passage back to its base, and never offers a dead tap for one it cannot join', () => {
        const hits = group(
            'documents',
            { ...EMPTY_CORPUS, documents: [DOC] },
            {
                ...EMPTY_MATCHES,
                passages: [
                    { document_id: 'd1', content: 'Pay each invoice within 30 days', title: null, source_uri: null },
                    { chunk_id: '9', content: 'An orphan invoice note', title: 'Loose', source_uri: null },
                ],
            },
        )?.hits;
        expect(hits?.[0]).toMatchObject({ key: 'document:d1', title: 'Invoice policy', meta: 'Finance', href: '/knowledge/kb1' });
        expect(hits?.[1]).toMatchObject({ key: 'document:9', title: 'Loose', href: null });
        // The title match on the same document is not listed a second time.
        expect(hits).toHaveLength(2);
    });

    it('adds title matches after the passages', () => {
        const hits = group('documents', { ...EMPTY_CORPUS, documents: [DOC] }, EMPTY_MATCHES)?.hits;
        expect(hits).toEqual([
            expect.objectContaining({ key: 'document:d1', subtitle: 'Finance · 1 chunk', href: '/knowledge/kb1' }),
        ]);
    });

    it('filters knowledge bases, automations and meeting notes on the phone', () => {
        const corpus: SearchCorpus = {
            ...EMPTY_CORPUS,
            knowledgeBases: [
                { id: 'kb1', name: 'Invoices', description: null, document_count: 3, created_at: '' },
                { id: 'kb2', name: 'Other', description: null, created_at: '' },
            ],
            automations: [
                { id: 'a1', title: 'Invoice chaser', description: null, isActive: false, lastRunAt: null, updatedAt: null },
            ],
            transcripts: [
                { id: 't1', title: 'Weekly', fileName: null, status: 'completed', transcriptSnippet: 'we sent the invoice', createdAt: null, updatedAt: null },
            ],
        };
        expect(group('knowledge', corpus, EMPTY_MATCHES)?.hits).toEqual([
            expect.objectContaining({ title: 'Invoices', meta: '3 docs', href: '/knowledge/kb1' }),
        ]);
        expect(group('automations', corpus, EMPTY_MATCHES)?.hits[0]).toMatchObject({ subtitle: 'Paused', href: '/automations/a1' });
        expect(group('transcripts', corpus, EMPTY_MATCHES)?.hits[0]).toMatchObject({
            title: 'Weekly',
            subtitle: 'we sent the invoice',
            href: '/recordings/t1',
        });
    });

    it('caps a group at eight rows', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({
            id: `kb${i}`,
            name: `Invoice ${i}`,
            description: null,
            created_at: '',
        }));
        expect(group('knowledge', { ...EMPTY_CORPUS, knowledgeBases: many }, EMPTY_MATCHES)?.hits).toHaveLength(8);
    });

    it('carries each group’s error with it, next to the hits of the others', () => {
        const refused = new Error('403');
        const results = buildResults(
            // A word no sitemap destination answers to ("invoice" now finds Studio Documents).
            'zebra',
            { ...EMPTY_CORPUS, errors: { knowledge: refused } },
            { ...EMPTY_MATCHES, chats: [{ id: 'c1', title: 'Zebra', updated_at: '', kind: 'direct' }] },
            NOBODY,
        );
        expect(results.groups.find((g) => g.key === 'knowledge')?.error).toBe(refused);
        expect(results.groups.find((g) => g.key === 'chats')?.error).toBeNull();
        expect(results.total).toBe(1);
    });
});
