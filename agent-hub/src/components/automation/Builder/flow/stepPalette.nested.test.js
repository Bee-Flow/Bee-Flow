import { describe, it, expect } from 'vitest';
import { NOT_INSIDE_A_LAYER, buildStepGroups, buildSearchResults } from './stepPalette';

/**
 * DE ZESDE CANVASPLEK: HET PALET.
 *
 * De vijf plekken die flow/terminalSteps.test.js bewaakt gaan over een stap die
 * er AL staat. Deze gaat over de vraag of de editor hem daar überhaupt laat
 * neerzetten. Binnen een flowlet/Step én binnen een loop-body — beide komen
 * hier binnen als `inLayer:true` (BuildTab respectievelijk
 * mapping/LoopBodyEditor) — weigert de validator drie stapsoorten hard:
 *
 *   approval / form_page   `layer.approval_forbidden` / `layer.form_page_forbidden`
 *                          (validate/graph.js) en `*.nested_forbidden`
 *                          (validate/constants.js NESTED_FORBIDDEN_RULES)
 *   return_to_app          `layer.return_to_app_forbidden` én
 *                          `return_to_app.nested_forbidden`
 *
 * Bood het palet er één van tóch aan, dan werd de eerstvolgende autosave
 * geweigerd met een fout die het palet zojuist zelf had uitgelokt — precies de
 * faalvorm die de kop van flow/terminalSteps.js benoemt ("de validator weigert
 * een graaf die de editor zojuist heeft laten tekenen"). `return_to_app` zat in
 * FLOW_CONTROL_ITEMS en die sectie ging ongefilterd door; alleen PEOPLE_ITEMS
 * werd gefilterd.
 *
 * Dit is GEEN kopie van TERMINAL_STEP_TYPES: `stop_error` mag wél in een lus
 * (hij gooit, en een worp reist uit elke sub-graaf omhoog), en
 * approval/form_page zijn niet terminaal. De lijst gaat over de PLEK, niet over
 * het einde van de run.
 */
const kindsIn = (groups) => {
    const out = new Set();
    const eat = (items) => (items || []).forEach((it) => out.add(it?.payload?.kind));
    for (const g of groups) {
        if (g.kind === 'sections') g.sections.forEach((sec) => eat(sec.items));
        else eat(g.items);
    }
    return out;
};

describe('stepPalette — wat de validator binnen een lus/flowlet weigert, wordt daar niet aangeboden', () => {
    it('de lijst noemt de drie soorten die binnen een sub-graaf geen adres hebben', () => {
        expect([...NOT_INSIDE_A_LAYER].sort()).toEqual(['approval', 'form_page', 'return_to_app']);
        expect(NOT_INSIDE_A_LAYER.has('stop_error'), 'een stop MAG in een lus — hij gooit, en een worp reist omhoog').toBe(false);
    });

    it('browsen binnen een lus/flowlet biedt er geen van drieën aan', () => {
        const inside = kindsIn(buildStepGroups({ inLayer: true }));
        for (const kind of NOT_INSIDE_A_LAYER) {
            expect(inside.has(kind), `"${kind}" wordt binnen een lus/flowlet aangeboden terwijl de validator hem daar weigert`).toBe(false);
        }
    });

    it('…en op het hoofdcanvas staan ze er wél — anders bewijst de test hierboven niets', () => {
        const top = kindsIn(buildStepGroups({}));
        for (const kind of NOT_INSIDE_A_LAYER) {
            expect(top.has(kind), `"${kind}" is helemaal uit het palet verdwenen`).toBe(true);
        }
    });

    it('zoeken loopt langs dezelfde poort als browsen', () => {
        const kinds = (q, scope) => buildSearchResults(q, scope).map((r) => r.payload?.kind);
        expect(kinds('back to the app', { inLayer: true })).not.toContain('return_to_app');
        expect(kinds('approval', { inLayer: true })).not.toContain('approval');
        // Tegenproef: buiten de lus vindt dezelfde zoekterm hem wel.
        expect(kinds('back to the app', {})).toContain('return_to_app');
    });
});
