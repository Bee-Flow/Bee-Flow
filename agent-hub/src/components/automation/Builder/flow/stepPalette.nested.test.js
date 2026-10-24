import { describe, it, expect } from 'vitest';
import { NOT_INSIDE_A_LAYER, buildStepGroups, buildSearchResults } from './stepPalette';

/**
 * THE SIXTH CANVAS PLACE: THE PALETTE.
 *
 * The five places that flow/terminalSteps.test.js guards concern a step that is ALREADY there.
 * This one concerns whether the editor lets it be placed there at all. Inside a flowlet/Step
 * AND inside a loop body (both arrive here as `inLayer:true`, from BuildTab and
 * mapping/LoopBodyEditor respectively), the validator hard-refuses three step types:
 *
 *   approval / form_page   `layer.approval_forbidden` / `layer.form_page_forbidden`
 *                          (validate/graph.js) and `*.nested_forbidden`
 *                          (validate/constants.js NESTED_FORBIDDEN_RULES)
 *   return_to_app          `layer.return_to_app_forbidden` AND
 *                          `return_to_app.nested_forbidden`
 *
 * If the palette offered one of these anyway, the next autosave would be refused with an error
 * that the palette itself had just provoked. That is precisely the failure form that the header
 * of flow/terminalSteps.js names ("the validator refuses a graph that the editor has just let it
 * draw"). `return_to_app` sat in FLOW_CONTROL_ITEMS, and that section went through unfiltered;
 * only PEOPLE_ITEMS was filtered.
 *
 * This is NOT a copy of TERMINAL_STEP_TYPES: `stop_error` may sit in a loop (it throws, and a
 * throw travels out of every sub-graph), and approval/form_page are not terminal. The list is
 * about the PLACE, not about the end of the run.
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
