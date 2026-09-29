// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * BOTH surfaces that run an app must wire the live-browse frame store.
 *
 * An ai_browse step streams frames to `useActionRunner`'s `onBrowseEvent` sink,
 * and `browser_view` reads them back out of `BrowserRunProvider`. Wire only one
 * of the pair and nothing errors — `publish` is simply null, every frame is
 * dropped on the floor, and the panel sits on its idle placeholder for the whole
 * run. The step works; the screen lies about it.
 *
 * That is exactly what shipped: the standalone run page had both, the Studio
 * editor's Preview had neither. Someone previewing the app they had just built
 * watched an empty box and reasonably concluded the feature was broken.
 *
 * Asserted against the source rather than by rendering, because the failure is
 * an ABSENCE — a render test of the editor canvas would need the whole editor
 * context graph and would still pass if the wiring silently disappeared.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const SURFACES = [
    { name: 'standalone run page', file: '../../../../../pages/apps/AppRunPage.jsx' },
    { name: 'Studio editor canvas (Preview)', file: '../editor/Canvas.jsx' },
];

describe('live-browse frame store is wired on every app-running surface', () => {
    for (const surface of SURFACES) {
        it(`${surface.name}: creates the store, feeds the runner, and provides it`, () => {
            const src = read(surface.file);

            expect(src, 'imports the store').toMatch(/useBrowserRunStore/);
            // The sink: without this the runner drops frames silently.
            expect(src, 'passes publish to useActionRunner as onBrowseEvent')
                .toMatch(/onBrowseEvent:\s*\w+\.publish/);
            // The source: without this browser_view reads an empty default.
            expect(src, 'wraps the rendered tree in BrowserRunProvider')
                .toMatch(/<BrowserRunProvider\s+value=\{/);
        });
    }

    it('the two halves are never wired independently — a surface has both or neither', () => {
        for (const surface of SURFACES) {
            const src = read(surface.file);
            const hasSink = /onBrowseEvent:\s*\w+\.publish/.test(src);
            const hasProvider = /<BrowserRunProvider\s+value=\{/.test(src);
            expect(hasSink, `${surface.name}: sink and provider must agree`).toBe(hasProvider);
        }
    });
});
