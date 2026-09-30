/** Sources, versions, bodies and the preview token, read from the server's own shapes. */

import { readFiles, readSource, readVersion, readVersionPage } from './buildReaders';

describe('readSource', () => {
    it('falls back to a file that is still processing for an unknown shape', () => {
        expect(readSource({ id: 's1', type: 'mystery' })).toMatchObject({
            type: 'file',
            status: 'processing',
            storageKey: null,
            url: null,
        });
    });
});

describe('readVersion and readVersionPage', () => {
    it('reads the actor as "unknown" (null), never as you', () => {
        expect(readVersion({ id: 'v1', actor: null }).actor).toBeNull();
        expect(readVersion({ id: 'v1', actor: { name: 'Ada', isYou: 'yes' } }).actor).toEqual({
            name: 'Ada',
            isYou: false,
        });
        expect(readVersion({ id: 'v1', source: 'restore', lineDelta: '-3' })).toMatchObject({
            source: 'restore',
            lineDelta: -3,
        });
    });

    it('covers the project unless the server says it does not', () => {
        expect(readVersionPage({}).coversProject).toBe(true);
        expect(readVersionPage({ coverage: { coversProject: false } }).coversProject).toBe(false);
        expect(readVersionPage({ published: { versionId: 'v2', seq: 7 } }).published).toEqual({
            versionId: 'v2',
            seq: 7,
        });
        expect(readVersionPage({ published: { seq: 7 } }).published).toBeNull();
    });
});

describe('readFiles', () => {
    it('reads a missing slot as empty', () => {
        expect(readFiles({ files: { html: '<p>' } })).toEqual({ html: '<p>', css: '', js: '' });
        expect(readFiles(null)).toEqual({ html: '', css: '', js: '' });
    });
});
