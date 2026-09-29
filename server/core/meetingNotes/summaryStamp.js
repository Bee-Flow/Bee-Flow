// @typecheck
'use strict';

/**
 * Welk sjabloon heeft DEZE notitie geschreven — en welke versie ervan.
 *
 * Twee kolommen dragen dat feit: `transcriptions.summary_template_id` en
 * `transcriptions.summary_template_version`. Dit bestand is de enige plek waar
 * de vorm van die twee waarden wordt bepaald; routes en de ingest roepen hem
 * aan, niemand bouwt het paar met de hand.
 *
 * ── WAAROM DE VERSIE MEE OPGESLAGEN WORDT ────────────────────────────────
 * Alleen het id opslaan zou lijken te volstaan: de versie is immers op te
 * zoeken bij het sjabloon. Maar dat is een uitspraak over het VERLEDEN,
 * afgelezen aan het HEDEN — een sjabloon dat na de samenvatting is bijgewerkt
 * staat vandaag op v5 terwijl de notitie met v2 geschreven is. Het scherm zou
 * dan "gemaakt met v5" zeggen over tekst die v5 nooit heeft gezien. De versie
 * hoort dus bij de notitie, gestempeld op het moment van schrijven.
 *
 * ── WAAROM EEN PREFIX VOOR DE INGEBOUWDE SJABLONEN ───────────────────────
 * Een opgeslagen sjabloon heeft een UUID, een ingebouwde een leesbare sleutel
 * ('general', 'standup', …). Zonder markering moet de lezer aan de VORM van
 * het id raden welke van de twee het is — een UUID-regex als semantiek. Met
 * `builtin:` staat het er gewoon, en `parseStamp` geeft het antwoord terug in
 * plaats van een gok. Onbekend blijft onbekend: een id dat geen van beide
 * vormen heeft levert null op, niet "dan maar ingebouwd".
 *
 * ── NIETS IS OOK EEN ANTWOORD ────────────────────────────────────────────
 * Een eenmalige prompt ("probeer dit eens", niet opgeslagen) hoort GEEN
 * stempel te krijgen — en moet een oude stempel juist WISSEN: de samenvatting
 * die er nu staat is niet meer die van het vorige sjabloon. Daarvoor is
 * `EMPTY_STAMP`; het is een expliciete waarde, niet "de velden weglaten".
 */

const { BUILTIN_BY_ID } = require('./summaryTemplates');

const BUILTIN_STAMP_PREFIX = 'builtin:';

/** Geen sjabloon (eenmalige prompt). WIST een eerdere stempel — zie de kop. */
const EMPTY_STAMP = Object.freeze({ summaryTemplateId: null, summaryTemplateVersion: null });

/**
 * Stempel voor een ingebouwd sjabloon. Een onbekende sleutel valt — net als
 * `builtinPrompt` — terug op 'general', en de stempel noemt dan óók 'general':
 * de notitie is met die prompt geschreven, dus dat is wat er staat.
 */
function stampForBuiltin(templateId) {
    const resolved = BUILTIN_BY_ID[templateId] ? templateId : 'general';
    return { summaryTemplateId: BUILTIN_STAMP_PREFIX + resolved, summaryTemplateVersion: null };
}

/**
 * Stempel voor een opgeslagen sjabloon (rij uit summaryTemplateStore).
 * Een rij zonder bruikbare `version` (een oude installatie waar de kolom nog
 * leeg was) levert `null` op — geen verzonnen 1: dan weten we het id wél en de
 * versie niet, en dat verschil moet het scherm kunnen tonen.
 */
function stampForTemplate(template) {
    if (!template || typeof template.id !== 'string' || !template.id) return { ...EMPTY_STAMP };
    const v = Number(template.version);
    return {
        summaryTemplateId: template.id,
        summaryTemplateVersion: Number.isInteger(v) && v > 0 ? v : null,
    };
}

/**
 * Lees een opgeslagen stempel terug.
 * @returns {{kind: 'builtin'|'custom', key: string} | null} null = niets of onleesbaar.
 */
function parseStamp(summaryTemplateId) {
    if (typeof summaryTemplateId !== 'string') return null;
    const raw = summaryTemplateId.trim();
    if (!raw) return null;
    if (raw.startsWith(BUILTIN_STAMP_PREFIX)) {
        const key = raw.slice(BUILTIN_STAMP_PREFIX.length);
        return key ? { kind: 'builtin', key } : null;
    }
    return { kind: 'custom', key: raw };
}

module.exports = {
    BUILTIN_STAMP_PREFIX,
    EMPTY_STAMP,
    stampForBuiltin,
    stampForTemplate,
    parseStamp,
};
