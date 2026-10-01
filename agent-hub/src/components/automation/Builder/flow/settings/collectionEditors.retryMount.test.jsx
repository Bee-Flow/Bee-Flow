// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETRY_FORM_TYPES, FOREACH_FORM_TYPES } from './formState';

/**
 * Every editor that CAN carry the "if this fails" row actually mounts it.
 *
 * The row lives in nine per-type editors rather than inside StepRepeatSection,
 * because three of those editors wrap StepRepeatSection in a FormRow labelled
 * "Iteration" and a row nested there would inherit that label — it would read
 * as part of the loop setting, which it is not.
 *
 * The cost of nine mount points is the failure this file exists to catch: a
 * new step type gets its editor, gets its forEach row, and nobody remembers
 * the retry row — which is exactly how the loop toggle itself shipped on one
 * step type and stayed missing on five (C12/C16/C18). So the rule is
 * mechanical and checked from the SOURCE, not from a render: an editor that
 * renders <StepRepeatSection/> renders <RetrySection/> too, unless its step type
 * is deliberately off RETRY_FORM_TYPES.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** Editor sources, this folder and actionEditors/ under it. */
function editorFiles() {
    const roots = [here, path.join(here, 'actionEditors')];
    const out = [];
    for (const root of roots) {
        for (const name of fs.readdirSync(root)) {
            if (!name.endsWith('.jsx') || name.includes('.test.')) continue;
            out.push(path.join(root, name));
        }
    }
    return out;
}

/**
 * The editors that deliberately render the loop row and NOT the retry row,
 * with the reason. `set` computes values from data already in hand, so a
 * second attempt produces exactly what the first one did — see
 * RETRY_FORM_TYPES, which this list is the editor-side half of.
 */
const NO_RETRY = new Map([
    ['setEditors.jsx', 'set steps compute from data already in hand — try 2 == try 1'],
]);

describe('the retry row is mounted everywhere it is offered', () => {
    const rendersForEach = editorFiles().filter((f) =>
        fs.readFileSync(f, 'utf8').includes('<StepRepeatSection'));

    it('finds the editors at all — a rename must not silently empty this test', () => {
        // Without this the whole file passes vacuously the day someone moves
        // the editors into another folder.
        expect(rendersForEach.length).toBeGreaterThanOrEqual(9);
    });

    it.each(rendersForEach.map((f) => [path.basename(f), f]))(
        '%s mounts the retry row beside the loop row', (base, file) => {
            const src = fs.readFileSync(file, 'utf8');
            if (NO_RETRY.has(base)) {
                expect(src).not.toContain('<RetrySection');
                return;
            }
            expect(src).toContain('<RetrySection');
        });

    it('mounts it OUTSIDE the "Iteration" FormRow, whose label is not this row\'s', () => {
        // The three editors that wrap StepRepeatSection in a labelled row are the
        // reason the mount is per-editor. A regression here is invisible in a
        // unit render — the row still works, it just sits under a heading that
        // describes a different setting.
        for (const base of ['aiStepEditors.jsx', 'datatableEditors.jsx', 'knowledgeWriteEditors.jsx']) {
            const src = fs.readFileSync(path.join(here, base), 'utf8');
            const closeRow = src.indexOf('</FormRow>', src.indexOf('<StepRepeatSection'));
            const mount = src.indexOf('<RetrySection');
            expect(mount).toBeGreaterThan(closeRow);
        }
    });
});

describe('the two halves of the allow-list agree', () => {
    it('is the loop list minus `set`, plus `slide`', () => {
        // Stated as arithmetic rather than as a second copy of the list, so a
        // type added to one and forgotten in the other fails here instead of
        // shipping a row that saves nothing (or a save with no row).
        const expected = new Set([...FOREACH_FORM_TYPES].filter((t) => t !== 'set'));
        expected.add('slide');
        expect([...RETRY_FORM_TYPES].sort()).toEqual([...expected].sort());
    });
});
