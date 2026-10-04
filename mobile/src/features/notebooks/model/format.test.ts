/**
 * What a source row says about its ingestion: the worker's stage while it
 * runs, the error when it fails, and otherwise its size or its address.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { isWorking, readyLine, sourceIcon, sourceSubtitle, stageLabel } from './format';
import type { NotebookSource } from './types';

const source = (over: Partial<NotebookSource> = {}): NotebookSource => ({
    id: 's1',
    notebookId: 'nb1',
    type: 'pdf',
    name: 'Contract.pdf',
    storageKey: null,
    fileName: null,
    metadata: {},
    status: 'ready',
    stage: null,
    error: null,
    wordCount: 0,
    sortOrder: 0,
    hasContent: true,
    createdAt: null,
    updatedAt: null,
    ...over,
});

describe('isWorking', () => {
    it('is true while pending or processing, and only then', () => {
        expect(isWorking(source({ status: 'pending' }))).toBe(true);
        expect(isWorking(source({ status: 'processing' }))).toBe(true);
        expect(isWorking(source({ status: 'ready' }))).toBe(false);
        expect(isWorking(source({ status: 'error' }))).toBe(false);
        // An undescribed row must never keep the notebook polling.
        expect(isWorking(source({ status: '' }))).toBe(false);
    });
});

describe('sourceSubtitle', () => {
    it('names the worker stage while ingesting, in the web’s words', () => {
        expect(sourceSubtitle(source({ status: 'processing', stage: 'embedding' }))).toBe('Indexing…');
        expect(sourceSubtitle(source({ status: 'processing', stage: 'queued' }))).toBe('Queued…');
        expect(sourceSubtitle(source({ status: 'pending' }))).toBe('Processing…');
    });

    it('names the stages the web names, in the same words', () => {
        const web = fs.readFileSync(`${AGENT_HUB_SRC}/pages/notebooks/sources/sourceMeta.ts`, 'utf8');
        const pairs = [...web.matchAll(/^\s+case '([a-z]+)': return t\('notebooks\.stage_[a-z]+', '([^']+)'\);$/gm)];
        expect(pairs.map((m) => m[1])).toEqual(['queued', 'extracting', 'fetching', 'embedding']);
        for (const [, stage, words] of pairs) expect(stageLabel(stage as string)).toBe(words);
    });

    it('shows the error, or a stated fallback, when ingestion failed', () => {
        expect(sourceSubtitle(source({ status: 'error', error: 'Unreadable PDF' }))).toBe('Unreadable PDF');
        expect(sourceSubtitle(source({ status: 'error' }))).toBe('Failed');
    });

    it('counts words once ready, and falls back to a link source’s address', () => {
        expect(sourceSubtitle(source({ wordCount: 1200 }))).toMatch(/1[\s,.]?200 words/);
        expect(sourceSubtitle(source({ type: 'url', metadata: { url: 'https://example.com' } }))).toBe(
            'https://example.com',
        );
        expect(sourceSubtitle(source())).toBe('');
    });
});

describe('readyLine', () => {
    it('says all are ready only when they are', () => {
        expect(readyLine(0, 0)).toBe('0 / 0 ready');
        expect(readyLine(1, 3)).toBe('1 / 3 ready');
        expect(readyLine(3, 3)).toBe('All 3 sources ready');
    });
});

describe('sourceIcon', () => {
    it('maps the type strings routes/notebooks.js writes', () => {
        expect(sourceIcon('pdf')).toBe('FileText');
        expect(sourceIcon('csv')).toBe('LayoutGrid');
        expect(sourceIcon('url')).toBe('Link');
        expect(sourceIcon('meeting')).toBe('Mic');
        expect(sourceIcon('something-new')).toBe('File');
    });
});
