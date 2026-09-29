/**
 * De markeringen in de Code-tab: welke regel krijgt welke tint?
 *
 * ── DIT MODULE ZOEKT NIETS OP ───────────────────────────────────────
 *
 * Er staat hier geen enkele regex en geen enkele tagnaam. WAAR een `bf-*`-
 * element staat komt van de server, uit dezelfde parser als de rest van W4
 * (`core/webpages/webpageBindings.js` → `GET /api/webpages/:id/bindings`),
 * die op zijn beurt het vocabulaire uit `core/webpages/bfElements.js` haalt.
 *
 * Een tweede regex hier zou een tweede lezing van hetzelfde vocabulaire zijn,
 * en twee lezingen lopen uit elkaar — dat is precies wat er met
 * `window.beeflowAI` al is gebeurd. Dit bestand doet één ding: het vertaalt
 * markeringen naar Monaco-decoraties.
 *
 * ── DE FAMILIES ─────────────────────────────────────────────────────
 *
 * Een tint per FAMILIE, niet per element: waar het element aan hangt is wat de
 * auteur wil zien, niet hoe het heet. De families komen uit het vocabulaire
 * zelf (`binding.kind` in de gespiegelde registry), plus twee die geen binding
 * ZIJN maar wel een eigen kleur verdienen:
 *
 *   incomplete  het element is er, maar een verplicht attribuut ontbreekt —
 *               het hangt dus nergens aan. Dat is iets anders dan geen element,
 *               en ook iets anders dan een adres dat de pagina ter plekke
 *               bouwt (`dynamic`): dáár heeft de auteur het wél opgeschreven,
 *               dus dat blijft gewoon zijn eigen familie houden;
 *   unknown     de server kende dit `bf-*`-element niet. In de publieke
 *               snapshot pakt DOMPurify zoiets stil uit, dus hier hoort het
 *               juist op te vallen.
 *
 * Voegt de registry morgen een familie toe, dan verschijnt die vanzelf in
 * `BF_FAMILIES`; `bfDecorations.test.js` eist dan een tint in vscode-theme.css,
 * zodat een nieuwe familie niet ongemerkt kleurloos blijft.
 */

import { BF_ELEMENTS } from '../../utils/bfElements';

/** Families die geen binding zijn, maar wel een eigen tint hebben. */
const EXTRA_FAMILIES = Object.freeze(['incomplete', 'unknown']);

/** Elke familie die een markering kan dragen, in vocabulairevolgorde. */
export const BF_FAMILIES = Object.freeze([
    ...BF_ELEMENTS.reduce((acc, def) => {
        const kind = def.binding && def.binding.kind;
        if (kind && !acc.includes(kind)) acc.push(kind);
        return acc;
    }, []),
    ...EXTRA_FAMILIES,
]);

/**
 * De familie van één markering.
 *
 * De volgorde van de vragen is de bedoeling:
 *
 *   1. "kennen we dit element?" — een onbekend element mag nooit als een
 *      gewoon element zonder koppeling worden getekend;
 *   2. "ontbreekt er iets verplichts?" — dan hangt het nergens aan, wat de
 *      auteur waarschijnlijk zelf moet afmaken. De server houdt de familie
 *      van het SOORT element (een `bf-table` zonder bron is nog steeds een
 *      tabelelement), dus dit onderscheid leest op `missing`, niet op `family`;
 *   3. anders de familie zelf.
 */
export function familyOf(mark) {
    if (!mark) return 'unknown';
    if (mark.known === false) return 'unknown';
    if (Array.isArray(mark.missing) && mark.missing.length > 0) return 'incomplete';
    if (mark.family && BF_FAMILIES.includes(mark.family)) return mark.family;
    return 'incomplete';
}

/**
 * WAT ER VAN DIT ELEMENT OVERBLIJFT ZODRA DE PAGINA GEPUBLICEERD IS.
 *
 * De Code-tab tekende élk bf-element als een gelijkwaardige "Studio link",
 * terwijl drie van de vijf op een gepubliceerde pagina dood zijn: er draait daar
 * geen JS, dus een knop, een formulier en een agentblok worden een zichtbaar
 * uitgeschakeld blok met een melding (services/webpageBfTable.js). Het ENIGE
 * scherm dat de koppelingen zichtbaar maakt, maakte dat verschil niet — terwijl
 * de gegevens er al lagen: de gespiegelde registry draagt per element zowel de
 * toestand als de zin die de lezer te zien krijgt.
 *
 * @returns {{state:string, notice:string}|null} `null` voor een tag die het
 *   vocabulaire niet kent — daar valt niets over te beweren.
 */
export function publishedFate(tag) {
    const def = BF_ELEMENTS.find(e => e.tag === String(tag || '').toLowerCase());
    if (!def) return null;
    const vanilla = (def.surfaces && def.surfaces.vanillaSnapshot) || null;
    if (!vanilla) return null;
    return { state: vanilla.state, notice: vanilla.notice || '' };
}

/** Blijft dit element werken op de gepubliceerde pagina? */
export function survivesPublishing(tag) {
    const fate = publishedFate(tag);
    // Onbekend telt NIET als "overleeft het": DOMPurify pakt zo'n element stil
    // uit, en dat is het tegenovergestelde van overleven.
    if (!fate) return false;
    return fate.state === 'static' || fate.state === 'live';
}

/** De CSS-klasse van een familie. De tinten staan in vscode-theme.css. */
export function familyClass(family) {
    return `bf-mark--${family}`;
}

/**
 * Markeringen van ÉÉN bestand, gegroepeerd per regel.
 *
 * Twee elementen op één regel worden één decoratie: twee tinten over elkaar
 * heen leveren een derde kleur op die niets betekent, en twee labels achter
 * elkaar zijn onleesbaar. De regel houdt de familie van het eerste element en
 * het label noemt ze allebei.
 */
export function groupMarksByLine(marks) {
    const byLine = new Map();
    for (const mark of (Array.isArray(marks) ? marks : [])) {
        const line = Number(mark && mark.line);
        if (!Number.isInteger(line) || line < 1) continue;
        if (!byLine.has(line)) byLine.set(line, []);
        byLine.get(line).push(mark);
    }
    return [...byLine.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, group]) => ({ line, marks: group, family: familyOf(group[0]) }));
}

/**
 * Monaco-decoraties voor één bestand.
 *
 * Puur: geen Monaco-import, geen editor — een lijst gewone objecten, zodat
 * deze vertaling te testen valt zonder een editor te starten.
 *
 * @param {Array} marks    de markeringen van DIT bestand
 * @param {object} [opts]
 * @param {(group:{line:number,marks:Array,family:string}) => string} [opts.label]
 *        de tekst achter de regel. Wordt in de component met `t()` gemaakt —
 *        vertaalde tekst hoort niet in een puur model.
 * @param {(group:object) => string} [opts.hover]  tekst van de tooltip
 * @returns {Array<{range:object, options:object}>}
 */
export function buildBfDecorations(marks, { label, hover } = {}) {
    return groupMarksByLine(marks).map((group) => {
        const text = typeof label === 'function' ? label(group) : '';
        const tip = typeof hover === 'function' ? hover(group) : '';
        const options = {
            isWholeLine: true,
            className: `bf-mark ${familyClass(group.family)}`,
            linesDecorationsClassName: `bf-mark-gutter ${familyClass(group.family)}`,
        };
        // Een leeg label zou een lege injectie opleveren die de cursor wél
        // verspringt; dan liever geen injectie.
        if (text) options.after = { content: `   ${text}`, inlineClassName: 'bf-mark-label' };
        if (tip) options.hoverMessage = { value: tip };
        return {
            range: {
                startLineNumber: group.line,
                startColumn: 1,
                endLineNumber: group.line,
                endColumn: 1,
            },
            options,
        };
    });
}

export default buildBfDecorations;
