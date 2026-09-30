/**
 * The small rules of the page screen: which sections a person gets, which
 * knowledge base is the page's own, how sources and versions read, and the
 * brief handed from the new-page sheet to the builder. What Preview shows is
 * in preview.test.ts.
 */

import type { WebpageSource, WebpageVersion } from './buildTypes';
import { attachedKnowledgeBaseIds, nextKnowledgeBaseIds, ownKnowledgeBaseId, toggleId } from './knowledgeBases';
import { parkBrief, takeBrief } from './pendingBrief';
import { anyProcessing, canCancelSource, canRetrySource, sourceDetail, sourceKindLabel, sourceStatus } from './sources';
import { initialTab, tabItems, tabsFor } from './tabs';
import type { Webpage } from './types';
import { actorLabel, flattenVersions, lineDeltaLabel, versionSourceLabel, versionTitle } from './versions';

const page = (over: Partial<Webpage> = {}): Webpage =>
    ({ id: 'wp1', runtime: 'light', slug: null, sourceCount: 0, knowledgeBaseIds: [], ...over }) as Webpage;

const source = (over: Partial<WebpageSource> = {}): WebpageSource => ({
    id: 's1',
    type: 'pdf',
    name: 'Brand.pdf',
    status: 'ready',
    error: null,
    wordCount: 1204,
    storageKey: null,
    url: null,
    createdAt: null,
    ...over,
});

const version = (over: Partial<WebpageVersion> = {}): WebpageVersion => ({
    id: 'v1',
    seq: 12,
    summary: 'Added a menu',
    source: 'ai',
    contentLength: 10,
    createdAt: null,
    actor: { name: null, isYou: true },
    lineDelta: 12,
    isPublished: false,
    ...over,
});

describe('tabs', () => {
    it('opens on Preview, and gives an org viewer only Preview and Share', () => {
        expect(tabsFor(true)).toEqual(['preview', 'share']);
        expect(initialTab('history', true)).toBe('preview');
        expect(initialTab('history', false)).toBe('history');
        expect(initialTab(undefined, false)).toBe('preview');
    });

    it('lands an old Build or Code link on Preview: there is no source view', () => {
        expect(tabsFor(false)).not.toContain('code');
        expect(initialTab('build', false)).toBe('preview');
        expect(initialTab('code', false)).toBe('preview');
    });

    it('counts sources on the Knowledge tab only', () => {
        const items = tabItems(false, { sources: 3 });
        expect(items.find((i) => i.id === 'knowledge')?.count).toBe(3);
        expect(items.find((i) => i.id === 'history')?.count).toBeUndefined();
    });
});

describe('knowledge bases', () => {
    it('keeps the page’s own base first once it has sources', () => {
        const withSources = page({ sourceCount: 2, knowledgeBaseIds: ['own', 'kb1'] });
        expect(ownKnowledgeBaseId(withSources)).toBe('own');
        expect(attachedKnowledgeBaseIds(withSources)).toEqual(['kb1']);
        expect(nextKnowledgeBaseIds(withSources, ['kb2', 'own', 'kb2'])).toEqual(['own', 'kb2']);
        expect(ownKnowledgeBaseId(page({ knowledgeBaseIds: ['kb1'] }))).toBeNull();
        expect(toggleId(['a'], 'a')).toEqual([]);
        expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    });
});

describe('sources', () => {
    it('offers retry only when the server kept something to read again', () => {
        expect(canRetrySource(source({ status: 'error', type: 'url' }))).toBe(true);
        expect(canRetrySource(source({ status: 'error', storageKey: 'k' }))).toBe(true);
        expect(canRetrySource(source({ status: 'error', type: 'text' }))).toBe(false);
        expect(canCancelSource(source({ status: 'processing' }))).toBe(true);
        expect(anyProcessing([source(), source({ status: 'processing' })])).toBe(true);
        expect(anyProcessing(undefined)).toBe(false);
    });

    it('reads as its kind, state and size or error', () => {
        expect(sourceKindLabel(source({ type: 'gdrive' }))).toBe('Google Drive');
        expect(sourceStatus(source({ status: 'error' }))).toEqual({ label: 'Failed', tone: 'error' });
        expect(sourceDetail(source())).toBe(`${(1204).toLocaleString()} words`);
        expect(sourceDetail(source({ status: 'error', error: 'Cancelled by user' }))).toBe('Cancelled by user');
        expect(sourceDetail(source({ status: 'processing' }))).toBeUndefined();
    });
});

describe('versions', () => {
    it('reads as number, maker, kind and line change', () => {
        expect(versionTitle(version())).toBe('v12 · Added a menu');
        expect(versionTitle(version({ seq: null, summary: ' ' }))).toBe('Snapshot');
        expect(actorLabel(version())).toBe('You');
        expect(actorLabel(version({ actor: null }))).toBe('Unknown');
        expect(actorLabel(version({ actor: { name: 'Ada', isYou: false } }))).toBe('Ada');
        expect([12, -3, 0, null].map((d) => lineDeltaLabel(version({ lineDelta: d })))).toEqual([
            '+12 lines',
            '−3 lines',
            'no line change',
            null,
        ]);
        expect(versionSourceLabel(version({ source: 'restore' }))).toBe('Before a restore');
    });

    it('flattens pages without repeating a row', () => {
        const pages = [
            { versions: [version(), version({ id: 'v2' })], hasMore: true, published: null, coversProject: true },
            {
                versions: [version({ id: 'v2' }), version({ id: 'v3' })],
                hasMore: false,
                published: null,
                coversProject: true,
            },
        ];
        expect(flattenVersions(pages).map((v) => v.id)).toEqual(['v1', 'v2', 'v3']);
    });
});

describe('pendingBrief', () => {
    it('hands a brief over once', () => {
        parkBrief('wp1', '  A bakery  ');
        parkBrief('wp2', '   ');
        expect(takeBrief('wp1')).toBe('A bakery');
        expect(takeBrief('wp1')).toBeNull();
        expect(takeBrief('wp2')).toBeNull();
    });
});
