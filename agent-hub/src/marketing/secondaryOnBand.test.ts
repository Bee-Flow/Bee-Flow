import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, 'marketing.css'), 'utf8');

// A secondary button on a dark or primary surface must be an outlined ghost
// (transparent fill, light text), whichever way the surface got there:
// block.style.band (a class on the wrapper) or content.backgroundVariant
// (a class on the section itself). jsdom resolves the cascade for literal
// values, so this checks the rule that actually ships.
const SURFACES = [
    ['band dark on the wrapper', 'cms-band--dark', 'cta-section'],
    ['band primary on the wrapper', 'cms-band--primary', 'cta-section'],
    ['band dark around a cta banner', 'cms-band--dark', 'cta-banner-block'],
    ['band dark around a hero', 'cms-band--dark', 'hero'],
] as const;

describe('secondary button on a dark or primary surface', () => {
    beforeAll(() => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    });
    afterEach(() => { document.body.innerHTML = ''; });

    const mount = (wrapperClass: string, sectionClass: string, sectionExtra = '') => {
        document.body.innerHTML = `<div class="marketing-root"><div class="${wrapperClass}">`
            + `<section class="${sectionClass} ${sectionExtra}"><a class="btn btn-secondary">x</a></section></div></div>`;
        return getComputedStyle(document.querySelector('.btn-secondary') as HTMLElement);
    };

    it.each(SURFACES)('is a transparent ghost with light text: %s', (_name, band, section) => {
        const cs = mount(band, section);
        expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
        expect(cs.color).toBe('rgb(255, 255, 255)');
        expect(cs.borderColor).toMatch(/rgba\(255, 255, 255, 0\.[5-9]/);
    });

    it('also covers a section that carries the dark variant itself', () => {
        const cs = mount('cms-block-wrap', 'cta-section', 'cms-bg--dark');
        expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
        expect(cs.color).toBe('rgb(255, 255, 255)');
    });

    it('leaves the secondary button alone on a plain band', () => {
        const cs = mount('cms-band--surface', 'cta-section');
        expect(cs.color).not.toBe('rgb(255, 255, 255)');
    });
});
