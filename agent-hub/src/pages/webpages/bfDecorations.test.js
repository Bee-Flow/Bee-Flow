import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BF_FAMILIES, buildBfDecorations, familyClass, familyOf, groupMarksByLine } from './bfDecorations';
import { BF_ELEMENTS } from '../../utils/bfElements';

/**
 * De markeringen: van een markering van de server naar een Monaco-decoratie.
 *
 * Wat hier vastligt:
 *   - de families komen uit het VOCABULAIRE, niet uit een lijst in de
 *     frontend, dus een nieuw element krijgt vanzelf een familie;
 *   - een onbekend element wordt nooit als een gewoon element getekend;
 *   - elke familie die dit bestand kan opleveren HEEFT een tint in
 *     vscode-theme.css — anders is een nieuwe familie stilzwijgend kleurloos.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/bfDecorations.test.js
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
        // Ook als de server om wat voor reden ook een familie meestuurt: eerst
        // "kennen we dit?", dan pas "waar hangt het aan".
        expect(familyOf(mark({ known: false, family: 'datatable' }))).toBe('unknown');
        expect(familyOf(null)).toBe('unknown');
    });

    it('een bekend element zonder zijn verplichte attribuut is "nog niet gekoppeld", niet "onbekend"', () => {
        // De server houdt de familie van het SOORT element, ook zonder adres;
        // wat het onderscheid draagt is `missing`. Wie hier op `family` zou
        // lezen, tekent een half geschreven element als een werkende koppeling.
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
        expect(deco.options.after.content).toContain('bf-table → tbl_1');
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
        // Zonder deze sanity zou een verkeerd pad of een leeggelopen bestand
        // een groene test opleveren die niets heeft gelezen.
        expect(css).toContain('.bf-mark {');
        for (const family of BF_FAMILIES) {
            expect(css, `familie "${family}" heeft geen tint: zijn markering zou kleurloos zijn`)
                .toContain(`.${familyClass(family)}`);
        }
    });
});
