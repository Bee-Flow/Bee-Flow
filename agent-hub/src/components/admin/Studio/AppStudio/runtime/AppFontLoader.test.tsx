import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AppFontLoader from './AppFontLoader';
import { FONT_STACKS } from './appDesign';

const PUBLIC_DIR = path.resolve(__dirname, '../../../../../../public');
const designFontsCss = readFileSync(path.join(__dirname, 'fonts/designFonts.css'), 'utf8');

/** Every address the document head asks the browser to fetch. */
function headAddresses(): string[] {
    return Array.from(document.head.querySelectorAll('link[href], script[src]'))
        .map((el) => el.getAttribute('href') ?? el.getAttribute('src') ?? '');
}

/** The url(...) values of a stylesheet, read with plain string operations. */
function cssUrls(css: string): string[] {
    return css.split('url(').slice(1).map((part) => part.slice(0, part.indexOf(')')).replaceAll("'", '').replaceAll('"', ''));
}

describe('AppFontLoader', () => {
    afterEach(() => { document.head.innerHTML = ''; });

    it.each([...Object.keys(FONT_STACKS), 'an-unknown-font'])('asks no other host for the design font %s', (font) => {
        render(<AppFontLoader definition={{ design: { font } }} />);
        expect(headAddresses().filter((href) => !href.startsWith('/'))).toEqual([]);
    });

    it('serves the geist, plex and poppins faces from Bee Flow, for files that exist', () => {
        const urls = cssUrls(designFontsCss);
        const families = new Set(urls.map((u) => u.split('/')[2]));
        expect(families).toEqual(new Set(['geist', 'ibm-plex-sans', 'poppins']));
        for (const url of urls) {
            expect(url.startsWith('/fonts/')).toBe(true);
            expect(existsSync(path.join(PUBLIC_DIR, url))).toBe(true);
        }
        for (const weight of ['400', '500', '600']) expect(designFontsCss).toContain(`font-weight: ${weight};`);
        for (const dir of ['geist', 'ibm-plex-sans', 'poppins']) {
            expect(existsSync(path.join(PUBLIC_DIR, 'fonts', dir))).toBe(true);
        }
    });
});
