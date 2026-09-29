import { describe, expect, it } from 'vitest';

/**
 * The header's responsive fold is CONTAINER-QUERY CSS — jsdom lays nothing
 * out, so no rendered test can catch its removal. Same answer the App Studio
 * header uses (EditorHeader.responsiveFold.test.js): pin the mechanism as
 * SOURCE, so the day someone strips "a few odd Tailwind classes" during a
 * cleanup this fails instead of the header silently growing a second line
 * (or painting over the inspector) at laptop widths.
 *
 * What must stay true:
 *   - the row is a named @container called `objhead`, 48px tall, and never
 *     wraps — folding, not wrapping, is the whole point of the recipe
 *     (BuilderHeader.jsx:125-136, `@container/bar`)
 *   - stage 1 (< 1440px): tab labels fold to icons and the name gets less
 *     room; the literal class is exported for callers' own words
 *   - stage 2 (< 1180px): the segment strip hides and the tab menu unhides
 *     at exactly that width; the literal class is exported for action words
 *   - the fold literals are spelled out (Tailwind emits nothing it cannot
 *     read as one literal), which is also what lets a StatusActionPill with
 *     containerName="objhead" fold inside this header
 */

async function readSource() {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(__dirname, 'StudioSectionHeader.jsx'), 'utf8');
}

describe('StudioSectionHeader — the responsive fold stays wired', () => {
    it('is a 48px non-wrapping named container called objhead', async () => {
        const src = await readSource();
        const row = src.match(/className=\{`@container\/objhead[^`]*`/);
        expect(row).not.toBeNull();
        expect(row[0]).toMatch(/\bh-12\b/);
        expect(row[0]).toMatch(/\bflex-nowrap\b/);
        expect(row[0]).toMatch(/\bmin-w-0\b/);
        expect(row[0]).not.toMatch(/\bflex-wrap\b/);
        // A different container name would silently orphan every fold class
        // (the docblock may cite BuilderHeader's `bar`; a className may not).
        expect(src).not.toMatch(/className=[{"'`]*@container\/(bar|edhead|ndvhead|ribbon)\b/);
    });

    it('stage 1 (< 1440px) squeezes the name and folds tab labels to icons', async () => {
        const src = await readSource();
        expect(src).toMatch(/max-w-\[22rem\] @max-\[1440px\]\/objhead:max-w-\[12rem\]/);
        // The label fold is a literal the tabs use AND callers can import.
        expect(src).toMatch(/label: '@max-\[1440px\]\/objhead:hidden'/);
        expect(src).toMatch(/className=\{OBJHEAD_FOLD\.label\}/);
    });

    it('stage 2 (< 1180px) swaps the segment strip for the tab menu', async () => {
        const src = await readSource();
        // The strip hides…
        expect(src).toMatch(/flex-shrink-0 @max-\[1180px\]\/objhead:hidden/);
        // …and the menu unhides at exactly the same width.
        expect(src).toMatch(/hidden @max-\[1180px\]\/objhead:block/);
        // Action words fold with the same literal, exported for callers.
        expect(src).toMatch(/action: '@max-\[1180px\]\/objhead:hidden'/);
    });

    it('spells every fold class as a literal — never built from the container name', async () => {
        const src = await readSource();
        // A template like `@max-[1440px]/${name}:hidden` is invisible to Tailwind.
        expect(src).not.toMatch(/@max-\[\d+px\]\/\$\{/);
    });

    it('the narrow-width menu is portalled (AnchoredMenu), not an absolute panel', async () => {
        const src = await readSource();
        expect(src).toMatch(/import AnchoredMenu from '\.\/AnchoredMenu'/);
        expect(src).toMatch(/<AnchoredMenu[\s\S]*role="menu"/);
        expect(src).not.toMatch(/absolute[^"']*top-full/);
    });

    it('paints with tokens only — no hex, no ink-filled button', async () => {
        const src = await readSource();
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(src).not.toMatch(/background:\s*'var\(--text-primary\)'/);
        // The recipe callers must use for a filled primary action.
        expect(src).toMatch(/background: 'var\(--accent-primary\)'/);
        expect(src).toMatch(/color: 'var\(--accent-primary-fg\)'/);
        expect(src).not.toMatch(/window\.(confirm|alert)/);
    });
});
