import { API_BASE, authFetch } from '../../../../utils/helpers';
import { KIND_KEYS } from '../../../shared/kindColors';

/**
 * De client van POST /api/studio/ai/route — "beschrijf het, de AI kiest de
 * bouwsteen" (Track H4, v1: CLASSIFICEREN en OVERDRAGEN).
 *
 * Het antwoord van een model is ONVERTROUWDE INVOER, ook nadat de server het
 * al een keer heeft geklemd. Daarom komt hier niets ongelezen doorheen: elke
 * `kind` wordt tegen KIND_KEYS gehouden (dezelfde lijst die de kleuren en de
 * iconen voedt), elke metgezel die daar niet in staat wordt GEDROPT in plaats
 * van gerepareerd, en een `kind` dat we niet kennen leidt tot
 * `undecided: true` — nooit tot een gok.
 *
 * ── Het onderscheid dat dit bestand moet bewaken ────────────────────────────
 *
 * "Niets gevonden" en "kon niet lezen" zijn twee verschillende antwoorden:
 *
 *   { ok: true,  kind: null }      de router HEEFT geantwoord en koos geen
 *                                  bouwsteen (waarom, staat in `available` en
 *                                  `undecided` hieronder)
 *   { ok: false, code: 'failed' }  er is helemaal geen antwoord
 *
 * Een mislukte fetch geeft dus NOOIT `kind: null` binnen een geslaagd
 * resultaat: dan zou het scherm "de AI koos niets" zeggen terwijl het netwerk
 * omviel, en dat is precies het soort stille degradatie waar dit programma op
 * stukloopt.
 *
 * `available` en `undecided` zijn LIJSTEN VAN SOORTEN, precies zoals
 * server/routes/studio/aiRoute.js ze stuurt, en ze staan er om dezelfde reden
 * (huisregel 12: onbekend versmalt): `available` is wat deze lezer mag bouwen,
 * `undecided` de soorten waarvan de gate niet te lezen was. Een LEGE
 * `available` met een LEGE `undecided` betekent "je mag hier niets bouwen"; een
 * lege `available` met een GEVULDE `undecided` betekent "we konden het niet
 * uitzoeken" — twee verschillende zinnen op het scherm, en dat verschil mag
 * hier niet verloren gaan. Zegt de server er niets over, dan is `available`
 * `null`: dat is niet "mag alles", maar "onbekend", en de UI valt dan terug op
 * zijn eigen tweede rem (de gegate `sections`).
 *
 * Afbreken is geen fout: een AbortError wordt DOORGEGOOID, zodat de aanroeper
 * "ik heb geannuleerd" niet als "het mislukte" hoeft te renderen.
 */

/** De vijf codes die dit endpoint kent. Al het overige wordt `failed`. */
export const ROUTE_ERROR_CODES = Object.freeze(['no_text', 'no_model', 'ai_unusable', 'rate_limited', 'failed']);

// De statusafspraak van het endpoint, één op één met server/routes/skills/ai.js:
// lege invoer 400, geen model 503, model gaf onbruikbare structuur 502,
// te vaak achter elkaar 429.
const CODE_BY_STATUS = Object.freeze({
    400: 'no_text',
    429: 'rate_limited',
    502: 'ai_unusable',
    503: 'no_model',
});

const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/** Een soort die we kennen, of null. Onbekend wordt nooit doorgegeven. */
const asKind = (value) => {
    const key = asText(value);
    return KIND_KEYS.includes(key) ? key : null;
};

/** Een lijst soorten die we kennen, of null als het er geen lijst was. */
const asKindList = (value) => {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const entry of value) {
        const kind = asKind(entry);
        if (kind && !out.includes(kind)) out.push(kind);
    }
    return out;
};

/**
 * De metgezellen als rijen `{ kind, name }`.
 *
 * H4b (na K8) maakt hiervan gekoppelde lege schillen; in v1 zijn ze puur
 * informatief. Kapotte entries verdwijnen, de hoofdsoort staat er niet nog
 * eens in (die is de kop van de kaart) en dubbele soorten tellen één keer.
 */
const asCompanions = (value, mainKind) => {
    if (!Array.isArray(value)) return [];
    const seen = new Set(mainKind ? [mainKind] : []);
    const out = [];
    for (const entry of value) {
        const kind = asKind(typeof entry === 'string' ? entry : entry?.kind);
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        out.push({ kind, name: asText(typeof entry === 'string' ? '' : entry?.name) });
    }
    return out;
};

const errorFrom = (status, body) => {
    const claimed = asText(body?.code);
    if (ROUTE_ERROR_CODES.includes(claimed)) return { ok: false, code: claimed };
    return { ok: false, code: CODE_BY_STATUS[status] || 'failed' };
};

/**
 * Vraag de router welke bouwsteen bij deze beschrijving hoort.
 *
 * @param {string} text de brief van de gebruiker
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: true, kind: string|null, name: string, seed: string,
 *                     companions: {kind: string, name: string}[],
 *                     available: string[]|null, undecided: string[] }
 *                  | { ok: false, code: string }>}
 */
export async function routeDescription(text, { signal } = {}) {
    const body = asText(text);
    // Geen netwerkoproep voor een lege brief: de server antwoordt hier 400
    // `no_text`, en dat antwoord kennen we al voordat we hem lastigvallen.
    if (!body) return { ok: false, code: 'no_text' };

    let res;
    try {
        res = await authFetch(`${API_BASE}/api/studio/ai/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: body }),
            signal,
        });
    } catch (err) {
        // Annuleren is een keuze van de gebruiker, geen storing.
        if (err?.name === 'AbortError') throw err;
        return { ok: false, code: 'failed' };
    }

    if (!res || !res.ok) {
        let payload = null;
        try { payload = await res.json(); } catch { /* geen JSON — status beslist */ }
        return errorFrom(res?.status, payload);
    }

    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    // 200 met een onleesbare body is geen "niets gevonden": we hebben het
    // antwoord niet kunnen lezen.
    if (!payload || typeof payload !== 'object') return { ok: false, code: 'failed' };

    const kind = asKind(payload.kind);
    return {
        ok: true,
        kind,
        name: asText(payload.name),
        seed: asText(payload.seed),
        companions: asCompanions(payload.companions, kind),
        available: asKindList(payload.available),
        undecided: asKindList(payload.undecided) || [],
    };
}

export default routeDescription;
