// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    PRIMARY_SLOTS, PRIMARY_SLOT_NAMES, buildCodeFiles, formatBytes, markFileKey, utf8Bytes,
} from './webpageCodeFiles';

/**
 * The file strip of the Code tab.
 *
 * What is fixed here is not "the strip counts bytes", but what it may CLAIM:
 * the three slots are not always the project, every extra file counts, and a
 * size we do not know is `null` — never 0, because "0 B" is a statement about a
 * file we have not read.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/webpageCodeFiles.test.js
 */

const mark = (over = {}) => ({
    source: 'index.html', slot: 'html', line: 1, tag: 'bf-table',
    known: true, family: 'datatable', targetId: 'tbl_1', fallback: null, missing: [], reason: null,
    ...over,
});

describe('de drie namen liggen vast', () => {
    it('heet index.html / style.css / script.js — een bewuste afwijking van styles.css en app.js', () => {
        expect(PRIMARY_SLOTS.map(s => s.slot)).toEqual(['html', 'css', 'js']);
        expect(PRIMARY_SLOT_NAMES).toEqual(['index.html', 'style.css', 'script.js']);
    });
});

describe('utf8Bytes / formatBytes', () => {
    it('telt echte bytes, niet tekens', () => {
        // 'é' is one character and two bytes; String.length would say 1 here and
        // give the strip too small a size.
        expect(utf8Bytes('é')).toBe(2);
        expect(utf8Bytes('')).toBe(0);
    });

    it('geeft null in plaats van een verzonnen getal', () => {
        expect(utf8Bytes(undefined)).toBeNull();
        expect(formatBytes(null)).toBeNull();
        expect(formatBytes(-1)).toBeNull();
    });

    it('schrijft B, KB en MB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    });
});

describe('markFileKey', () => {
    it('adresseert een slot op zijn slot en een extra op zijn pad', () => {
        expect(markFileKey(mark({ slot: 'css' }))).toBe('css');
        expect(markFileKey(mark({ slot: null, source: 'src/App.jsx' }))).toBe('extra:src/App.jsx');
        expect(markFileKey(null)).toBeNull();
    });
});

describe('buildCodeFiles — toon wat er IS', () => {
    it('een vanilla-project houdt zijn drie slots, ook een lege', () => {
        const { files } = buildCodeFiles({ framework: 'vanilla', html: '<p>hi</p>', css: '', js: '' });
        expect(files.map(f => f.name)).toEqual(['index.html', 'style.css', 'script.js']);
        expect(files.find(f => f.name === 'style.css').bytes).toBe(0);
    });

    it('BIJT — een react-mui-project krijgt GEEN drie vakjes waarvan er twee leeg blijven', () => {
        const { files } = buildCodeFiles({
            framework: 'react-mui',
            html: '', css: '', js: '',
            extraFiles: [
                { path: 'src/main.jsx', size: 120, isText: true },
                { path: 'src/App.jsx', size: 900, isText: true },
            ],
        });
        // The slots do not exist there as a file: the html is generated and
        // css/js are not used. Drawing them would lie to the author.
        expect(files.map(f => f.name)).toEqual(['src/main.jsx', 'src/App.jsx']);
    });

    it('een react-mui-slot dat WEL inhoud heeft, blijft staan', () => {
        const { files } = buildCodeFiles({ framework: 'react-mui', html: '<div id="root"></div>' });
        expect(files.map(f => f.name)).toEqual(['index.html']);
    });

    it('BIJT — een vanilla-project verzwijgt zijn extra bestanden niet, ook geen binaire', () => {
        const { files } = buildCodeFiles({
            framework: 'vanilla',
            html: 'x', css: '', js: '',
            extraFiles: [
                { path: 'modules/state.js', size: 40, isText: true },
                { path: 'assets/logo.png', size: 2048, isText: false },
            ],
        });
        expect(files.map(f => f.name)).toEqual([
            'index.html', 'style.css', 'script.js', 'modules/state.js', 'assets/logo.png',
        ]);
        // An image is not text, but it is there — and its bytes count
        // towards how large this page is.
        expect(files.find(f => f.name === 'assets/logo.png')).toMatchObject({ isText: false, bytes: 2048 });
    });

    it('de geladen inhoud wint van de opgeslagen grootte', () => {
        const { files } = buildCodeFiles({
            extraFiles: [{ path: 'notes.md', size: 4, isText: true }],
            extraContents: { 'notes.md': { isText: true, content: 'hallo wereld' } },
        });
        expect(files.find(f => f.name === 'notes.md').bytes).toBe(12);
    });

    it('BIJT — een grootte die we niet kennen is null, en het totaal zegt dat het onvolledig is', () => {
        const out = buildCodeFiles({
            framework: 'react-mui',
            extraFiles: [{ path: 'src/App.jsx', isText: true }],
        });
        expect(out.files[0].bytes).toBeNull();
        expect(out.bytesComplete).toBe(false);
    });

    it('telt de markeringen per bestand', () => {
        const { files } = buildCodeFiles({
            framework: 'vanilla',
            html: 'x', css: '', js: '',
            marks: [mark({ line: 1 }), mark({ line: 7 }), mark({ slot: 'js', source: 'script.js', line: 2 })],
        });
        expect(files.find(f => f.key === 'html').marks).toBe(2);
        expect(files.find(f => f.key === 'js').marks).toBe(1);
        expect(files.find(f => f.key === 'css').marks).toBe(0);
    });

    it('BIJT — een bestand dat alleen de server kent, verschijnt tóch in de strip', () => {
        // The AI has just created a file: the scan saw it, the editor
        // does not have it yet. Staying silent would produce a mark in a
        // file that does not seem to exist.
        const { files, bytesComplete } = buildCodeFiles({
            framework: 'vanilla',
            html: 'x', css: '', js: '',
            marks: [mark({ slot: null, source: 'src/New.jsx', line: 3 })],
        });
        const added = files.find(f => f.name === 'src/New.jsx');
        expect(added).toBeTruthy();
        expect(added.loaded).toBe(false);
        expect(added.openable).toBe(false);
        expect(added.bytes).toBeNull();
        expect(bytesComplete).toBe(false);
    });

    it('telt het totaal alleen over bestanden waarvan we de bytes kennen', () => {
        const out = buildCodeFiles({ framework: 'vanilla', html: 'abcd', css: 'ab', js: '' });
        expect(out.totalBytes).toBe(6);
        expect(out.bytesComplete).toBe(true);
    });
});
