/**
 * The rich blocks' readers: model JSON in, typed trees out, with the web's
 * defaults and its derived numbers — and nothing on Object.prototype mistaken
 * for a block type.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { DOCUMENT_CARD, linkCardKind, WEBPAGE_CARD } from '../links/linkCards';
import { mapsLinkFor, readEmbed, readMap } from '../map/mapModel';
import { buttonOverlay, cellText, chartBars, readPage, rowCells } from '../page/pageModel';
import { readResearch, sourceDomain } from '../research/researchModel';
import { itemText, passRate, rateTone, readTestReport, summarise } from '../testReport/testReportModel';

describe('research', () => {
    it('reads every block type, nested sections and columns included', () => {
        const report = readResearch(
            JSON.stringify({
                title: 'T',
                blocks: [
                    { type: 'hero', title: 'H', date: 2026 },
                    { type: 'text', text: 'para' },
                    { type: 'image', url: 'https://x/y.png', height: 120, fit: 'contain' },
                    { type: 'sources', items: [{ url: 'https://www.a.com/x' }, { title: 'no url' }] },
                    { type: 'callout', variant: 'nope', content: 'c' },
                    { type: 'stats', items: [{ value: 78, label: 'Rate' }] },
                    { type: 'columns', children: [{ type: 'divider' }, { type: 'divider' }, { type: 'divider' }, { type: 'divider' }] },
                    { type: 'section', title: 'S', blocks: [{ type: 'markdown', content: '**b**' }] },
                    { type: 'custom', content: 'as markdown' },
                    { type: 'constructor' },
                    { nope: true },
                ],
            }),
        );
        expect(report?.blocks.map((b) => b.type)).toEqual([
            'hero', 'markdown', 'image', 'sources', 'callout', 'stats', 'columns', 'section', 'markdown',
        ]);
        expect(report?.blocks[0]).toMatchObject({ date: '2026' });
        expect(report?.blocks[3]).toMatchObject({ items: [{ url: 'https://www.a.com/x', title: '' }] });
        expect(report?.blocks[4]).toMatchObject({ variant: 'info' });
        expect(report?.blocks[6]).toMatchObject({ columns: 3 });
    });

    it('needs a blocks array, as the web does', () => {
        expect(readResearch('{"title":"x"}')).toBeNull();
        expect(readResearch('not json')).toBeNull();
    });

    it('names a source by its domain', () => {
        expect(sourceDomain('https://www.who.int/a')).toBe('who.int');
        expect(sourceDomain('not a url')).toBe('not a url');
    });
});

describe('test reports', () => {
    it('counts a missing summary from the tests, and bands the pass rate', () => {
        const report = readTestReport(
            JSON.stringify({ tests: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'warning' }, { name: 'c', status: 'odd' }] }),
        );
        expect(report?.summary).toEqual({ passed: 1, failed: 0, skipped: 1, warnings: 1 });
        expect(report?.tests[2]?.status).toBe('skipped');
        expect(passRate({ passed: 4, failed: 1, skipped: 0, warnings: 0 })).toBe(80);
        expect([80, 79, 50, 49].map(rateTone)).toEqual(['passed', 'warning', 'warning', 'failed']);
        expect(summarise({ passed: 2, failed: -1 }, [])).toEqual({ passed: 2, failed: 0, skipped: 0, warnings: 0 });
    });

    it('prints steps and recommendations as the web does', () => {
        expect(itemText('open')).toBe('open');
        expect(itemText({ action: 'click' })).toBe('click');
        expect(itemText({ x: 1 })).toBe('{"x":1}');
    });
});

describe('pages', () => {
    it('reads the root element', () => {
        expect(readPage('{"type":"page"}')).toEqual({ type: 'page' });
        expect(readPage('[1]')).toBeNull();
    });

    it('reads cells, rows, overlays and bars as the web does', () => {
        expect(cellText({ label: 'Col' })).toBe('Col');
        expect(rowCells({ a: 1, b: 'x' })).toEqual([1, 'x']);
        expect(buttonOverlay({ label: 'Go', href: 'https://x', action: 'run' })).toEqual({ title: 'Go', content: '', action: 'run', url: 'https://x' });
        expect(chartBars({ data: [{ label: 'a', value: 2 }, { label: 'b', value: 8 }] })).toMatchObject({ max: 8 });
    });
});

describe('maps', () => {
    it('reads a route or a place from the embed URL and builds a Maps link', () => {
        const route = readEmbed('https://www.google.com/maps/embed/v1/directions?key=k&origin=A%20B&destination=C&mode=walking');
        expect(route).toEqual({ place: null, route: { origin: 'A B', destination: 'C', mode: 'walking' } });
        expect(mapsLinkFor(null, route.route)).toBe(
            'https://www.google.com/maps/dir/?api=1&origin=A%20B&destination=C&travelmode=walking',
        );
        expect(readEmbed('https://www.google.com/maps/embed/v1/place?key=k&q=Dam%20Square').place).toBe('Dam Square');
    });

    it('prefers the tool’s own link, and needs an embed URL as the web does', () => {
        expect(readMap(JSON.stringify({ embedUrl: 'https://www.google.com/maps/embed/v1/place?q=x', mapsLink: 'https://maps.app/1' }))).toMatchObject({
            title: '',
            mapsLink: 'https://maps.app/1',
        });
        expect(readMap(JSON.stringify({ title: 'x' }))).toBeNull();
        expect(readMap(JSON.stringify({ embedUrl: 'https://www.google.com/maps/embed/v1/place?q=x', mapsLink: 'javascript:alert(1)' }))?.mapsLink).toBe(
            'https://www.google.com/maps/search/?api=1&query=x',
        );
    });
});

describe('link cards', () => {
    const WEB = fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/MarkdownRenderer.jsx`, 'utf8');

    it('uses the web’s patterns', () => {
        expect(WEB).toContain(`${String(WEBPAGE_CARD)}.test(href)`);
        expect(WEB).toContain(`${String(DOCUMENT_CARD)}.test(href)`);
    });

    it('cards webpages and Studio documents, nothing else', () => {
        expect(linkCardKind('/app/webpages/wp1')).toBe('webpage');
        expect(linkCardKind('/app/studio/webpages/wp_1')).toBe('webpage');
        expect(linkCardKind('/app/studio/documents/d-1')).toBe('document');
        expect(linkCardKind('/app/studio/documents/d-1/edit')).toBeNull();
        expect(linkCardKind('https://x.example/app/webpages/1')).toBeNull();
    });
});
