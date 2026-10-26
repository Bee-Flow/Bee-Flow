import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BF_FAMILIES, buildBfDecorations, familyClass, familyOf, groupMarksByLine } from './bfDecorations';
import { BF_ELEMENTS } from '../../utils/bfElements';

/**
 * The markers: from a marker of the server to a Monaco decoration.
 *
 * What is fixed here:
 *   - the families come from the VOCABULARY, not from a list in the frontend, so a new element automatically gets a family;
 *   - an unknown element is never drawn as an ordinary element;
 *   - every family that this file can yield HAS a shade in vscode-theme.css — otherwise a new family is silently colourless.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/bfDecorations.test.js
 */

const THEME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vscode-theme.css');

const mark = (over = {}) => ({
    source: 'index.html', slot: 'html', line: 1, tag: 'bf-table',
    known: true, family: 'datatable', targetId: 'tbl_1', fallback: null, missing: [], reason: null,
    ...over,
});

describe('BF_FAMILIES', () => {
    it('komt uit het vocabulaire, plus de twee die geen binding zijn', () => {
        const fromVocabulary = [...new Set(
            BF_ELEMENTS.map(def => def.binding && def.binding.kind).filter(Boolean),
        )];
        expect(fromVocabulary.length).toBeGreaterThan(1); // sanity: de spiegel is gelezen
        for (const kind of fromVocabulary) expect(BF_FAMILIES).toContain(kind);
        expect(BF_FAMILIES).toContain('incomplete');
        expect(BF_FAMILIES).toContain('unknown');
    });
});

describe('familyOf', () => {
    it('BIJT — een onbekend element is nooit een gewoon element', () => {
        // Even if the server for whatever reason sends along a family: first "do we know
        // this?", and only then "what does it hang on".
        expect(familyOf(mark({ known: false, family: 'datatable' }))).toBe('unknown');
        expect(familyOf(null)).toBe('unknown');
    });

    it('een bekend element zonder zijn verplichte attribuut is "nog niet gekoppeld", niet "onbekend"', () => {
        // The server keeps the family of the KIND of element, even without an address;
        // what distinguishes is `missing`. Whoever reads `family` here would draw a
        // half-written element as a working binding.
        expect(familyOf(mark({ targetId: null, missing: ['source'] }))).toBe('incomplete');
    });

    it('een adres dat de pagina ter plekke bouwt, blijft zijn eigen familie houden', () => {
        expect(familyOf(mark({ targetId: null, dynamic: true, missing: [] }))).toBe('datatable');
    });

    it('een familie die het vocabulaire niet kent, telt niet als familie', () => {
        expect(familyOf(mark({ family: 'verzonnen' }))).toBe('incomplete');
    });
});

describe('groupMarksByLine', () => {
    it('maakt van twee elementen op één regel één decoratie', () => {
        const groups = groupMarksByLine([
            mark({ line: 4 }),
            mark({ line: 4, tag: 'bf-button', family: 'automation' }),
            mark({ line: 9 }),
        ]);
        expect(groups.map(g => g.line)).toEqual([4, 9]);
        expect(groups[0].marks).toHaveLength(2);
        expect(groups[0].family).toBe('datatable');
    });

    it('negeert een markering zonder bruikbaar regelnummer in plaats van op regel 0 te tekenen', () => {
        expect(groupMarksByLine([mark({ line: 0 }), mark({ line: null })])).toEqual([]);
    });
});

describe('buildBfDecorations', () => {
    it('tint de hele regel met de klasse van de familie', () => {
        const [deco] = buildBfDecorations([mark({ line: 3 })], { label: () => 'bf-table → tbl_1' });
        expect(deco.range).toEqual({
            startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1,
        });
        expect(deco.options.isWholeLine).toBe(true);
        expect(deco.options.className).toContain(familyClass('datatable'));
        expect(deco.options.linesDecorationsClassName).toContain(familyClass('datatable'));
        expect(deco.options.after!.content).toContain('bf-table → tbl_1');
    });

    it('zet geen leeg label neer', () => {
        const [deco] = buildBfDecorations([mark()], { label: () => '' });
        expect(deco.options.after).toBeUndefined();
    });

    it('geeft een lege lijst terug bij geen markeringen — nooit een tint zonder aanleiding', () => {
        expect(buildBfDecorations([])).toEqual([]);
        expect(buildBfDecorations(null)).toEqual([]);
    });
});

describe('de tinten', () => {
    it('BIJT — elke familie heeft een kleur in vscode-theme.css', () => {
        const css = fs.readFileSync(THEME, 'utf8');
        // Without this sanity check, a wrong path or an emptied file
        // would produce a green test that read nothing.
        expect(css).toContain('.bf-mark {');
        for (const family of BF_FAMILIES) {
            expect(css, `familie "${family}" heeft geen tint: zijn markering zou kleurloos zijn`)
                .toContain(`.${familyClass(family)}`);
        }
    });
});
