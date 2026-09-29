/**
 * privacyLine.js — wat de privacyregel onder een bericht MAG beweren (C7).
 *
 * Het scherm heeft twee verschillende dingen te vertellen en de fout die deze
 * module onmogelijk maakt is ze door elkaar halen:
 *
 *   • DEMONSTRATIE — "1 gegeven vervangen door [email_1] — de echte waarde
 *     bleef hier". Dat is geen belofte maar een aanwijzing: de plaatsvervanger
 *     staat er, en de echte waarde staat leesbaar in de bubbel erboven. Die
 *     vorm mag alleen renderen als hij ook echt te tonen is.
 *   • ONBEWEZEN — de tokenmap ontbreekt (de org deelt hem niet met het scherm),
 *     dus de plaatsvervanger is hier niet bekend. Dan zegt de regel dát, en
 *     niets meer. Een geruststellende zin zonder meting eronder is erger dan
 *     geen zin: de gebruiker plakt er een beslissing op.
 *
 * De meting is bewust letterlijk. Een tokenmap-regel telt pas mee als de ECHTE
 * waarde woordelijk in de zichtbare berichttekst staat: dan — en alleen dan —
 * is aantoonbaar dat juist dít bericht die waarde bevatte, dat er een token
 * voor in de plaats ging, en dat het origineel hier nog staat. Een
 * conversatiebrede map (de kluis draagt tokens van eerdere beurten mee) levert
 * zo vanzelf alleen de regels op die over dit bericht gaan.
 *
 * Dat filter is nodig maar niet genoeg, en dat is de tweede regel hier: dat een
 * waarde hier staat bewijst niet dat de server hem in DEZE beurt verving. Zijn
 * er meer aantoonbare kandidaten dan de server vervangingen telde, dan hoort er
 * ten minste één niet bij deze beurt en weet het scherm niet welke — dan wijst
 * het niets aan. En waar een deel van de beurt helemaal niet gecontroleerd is
 * (fail_open), draagt de beschrijving dat als `incomplete` mee: de telling is
 * dan een ondergrens, geen samenvatting.
 *
 * Geen enkele functie hier kent tekst of sleutels: dit levert een beschrijving,
 * de component kiest de zin. De ternary hoort om de SLEUTEL, niet om de string.
 */

/** Hoeveel plaatsvervangers er hooguit op één regel passen. */
export const DEFAULT_TOKEN_LIMIT = 3;

/**
 * Te korte waarden matchen overal ("NL", "an") en zouden een demonstratie
 * ophangen aan toeval. Liever eerlijk degraderen dan vals bewijzen.
 */
const MIN_PROVABLE_VALUE = 3;

/** De zichtbare tekst van een bericht — string of content-parts. */
export function messageTextOf(msg) {
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
    }
    return '';
}

/**
 * De scan-waarschuwingen van een bericht, als lijst.
 *
 * ONBEKEND VERSMALT HIER. Dit veld is het enige oppervlak in de chat dat een
 * fail_open-DOORLAAT zichtbaar maakt: een deel van de upload is niet
 * gecontroleerd en is ongeredigeerd naar de AI gegaan. Voor precies dit veld
 * hoort een vorm die we niet herkennen te lezen als "we weten niet of de
 * controle rond kwam", nooit als "er was niets te melden". Een kale
 * `Array.isArray`-poort deed het omgekeerde: één object in plaats van een
 * lijst, een `{count}`-vorm of een JSON-kolom die als string terugkomt, en de
 * waarschuwing verdween spoorloos.
 */
export function normaliseScanWarnings(value) {
    if (value == null || value === false || value === '') return [];
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        const kept = value
            .filter(w => w != null && w !== false)
            .map(w => (typeof w === 'object' ? w : {}));
        // Een niet-lege lijst die niets herkenbaars overhoudt is nog steeds een
        // niet-lege lijst: er is iets gemeld, en dat mag niet wegvallen.
        return kept.length > 0 ? kept : [{}];
    }
    if (typeof value === 'object') return [value];
    return [{}];
}

/**
 * De tokenmap die bij DEZE beurt hoort: de eerstvolgende assistent-boodschap
 * na `idx`. De map landt server-side op het antwoord (sseEvents.js:
 * `privacy_token_map` → assistantMsgId), niet op het gebruikersbericht.
 *
 * Bij het volgende GEBRUIKERSbericht stoppen we: een map van een latere beurt
 * zegt niets over dit bericht.
 */
export function findTurnTokenMap(messages, idx) {
    if (!Array.isArray(messages)) return null;
    for (let i = Number(idx) + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'user') break;
        const map = m.tokenisationInfo?.tokenMap;
        if (map && typeof map === 'object' && Object.keys(map).length > 0) return map;
    }
    return null;
}

/**
 * De regels uit de tokenmap die over DIT bericht gaan, in leesvolgorde.
 *
 * Een regel telt alleen mee als de echte waarde woordelijk in de zichtbare
 * tekst staat. Dat is meteen het bewijs onder de zin: de plaatsvervanger ging
 * naar buiten, het origineel staat hier nog.
 */
function provableTokens(messageText, tokenMap) {
    const text = typeof messageText === 'string' ? messageText : '';
    const entries = (tokenMap && typeof tokenMap === 'object') ? Object.entries(tokenMap) : [];
    const proven = [];
    for (const [token, value] of entries) {
        if (typeof token !== 'string' || !token) continue;
        if (typeof value !== 'string' || value.length < MIN_PROVABLE_VALUE) continue;
        const at = text.indexOf(value);
        if (at === -1) continue;          // niet in dít bericht → geen bewijs
        proven.push({ token, at });
    }
    return proven.sort((a, b) => a.at - b.at);
}

/**
 * Beschrijf de regel.
 *
 * @param {object}  p
 * @param {number}  p.count           Wat de server telde (dlpRedactedCount / piiTokenizedCount).
 * @param {string}  p.messageText     De zichtbare tekst van het bericht.
 * @param {object}  p.tokenMap        { token: echte waarde } — of niets.
 * @param {number} [p.limit]          Hoeveel tokens er hooguit getoond worden.
 * @param {boolean}[p.scanIncomplete] Er is een deel van deze beurt NIET
 *   gecontroleerd en onder fail_open ongeredigeerd doorgelaten.
 * @returns {null|{form: 'demonstrated'|'unproven', count: number, tokens: string[],
 *   shown: number, partial: boolean, incomplete: boolean}}
 *   `null` als er niets te melden is. `shown` is nooit groter dan `count`,
 *   `partial` zegt dat er meer vervangen is dan hier aangetoond wordt, en
 *   `incomplete` dat de telling zelf niet het hele verhaal is.
 */
export function describePrivacyLine({
    count, messageText, tokenMap, limit = DEFAULT_TOKEN_LIMIT, scanIncomplete = false,
} = {}) {
    const n = Number(count) || 0;
    if (n <= 0) return null;
    const incomplete = !!scanIncomplete;
    const nothingShown = (form) => ({ form, count: n, tokens: [], shown: 0, partial: false, incomplete });

    const proven = provableTokens(messageText, tokenMap);

    // MEER KANDIDATEN DAN VERVANGINGEN → WIJS NIETS AAN.
    //
    // De kluismap is CONVERSATIEBREED: hij draagt tokens van eerdere beurten
    // mee. Een waarde die hier woordelijk staat, bewijst daarom alleen dát hij
    // hier staat — niet dat de server hem in DEZE beurt heeft vervangen. Zolang
    // er niet meer kandidaten zijn dan vervangingen kan elke kandidaat er een
    // van zijn. Zijn het er méér, dan is ten minste één kandidaat hier NIET
    // vervangen en zegt niets op dit scherm welke. Dan een van de twee
    // aanwijzen op tekstpositie is niet "de beste gok tonen" maar de lezer
    // laten concluderen dat de ándere in het klaar naar buiten ging.
    if (proven.length > n) return nothingShown('unproven');

    const tokens = proven.slice(0, limit).map(p => p.token);
    if (tokens.length === 0) return nothingShown('unproven');

    return {
        form: 'demonstrated',
        count: n,
        tokens,
        shown: tokens.length,
        partial: tokens.length < n,
        incomplete,
    };
}

export default describePrivacyLine;
