/**
 * personaFacts — de FEITEN achter de tab "Rol" (Agents-artboard 1c, A3 deel A),
 * los van hoe ze getekend worden.
 *
 * Alles hier is puur: in gaat de opgeslagen `agents.persona` plus de rauwe
 * automatiseringslijst, eruit komen FEITEN — nooit zinnen. De zinnen staan in de
 * kaarten, want daar staan ook de letterlijke `t()`-sleutels die de i18n-guard
 * leest. Een reden om iets NIET te mogen is daarom een CODE
 * (`'not_owner'`), geen tekst.
 *
 * ── DIT IS EEN SPIEGEL, EN DE SPIEGEL MOET KLOPPEN ──────────────────
 * `server/core/agentRuntime/personaPrompt.js` normaliseert elke persona
 * opnieuw bij het opslaan: hij knipt teksten af, ontdubbelt bullets
 * hoofdletter-ongevoelig en gooit alles boven de twintigste bullet weg. Deze
 * module doet exact hetzelfde vóórdat er iets de deur uit gaat, om één reden:
 * anders typt iemand een eenentwintigste regel, ziet hem staan, slaat op, en
 * is hij weg zonder dat er ooit iets op het scherm stond. Wijkt de server af,
 * dan wijkt deze module mee — niet andersom.
 *
 * ── DE TOONWAARDEN ZIJN PROMPTTEKST, GEEN UI-TEKST ──────────────────
 * `tone.chips` wordt letterlijk in het systeemprompt gerenderd
 * (`Tone: formal, friendly.`). De WAARDE moet dus stabiel Engels zijn — hij
 * mag niet meebewegen met de schermtaal, anders staat er morgen een andere
 * instructie in het prompt omdat iemand de interface op Duits zette, en klopt
 * "staat deze chip aan?" niet meer. Het LABEL gaat wél door `t()`; dat staat
 * in `ToneCard.jsx`.
 *
 * De eerste drie waarden komen uit het vocabulaire dat de server zelf al kent
 * (`personaPrompt.TONE_CHIPS`); de laatste twee niet, en dat mag: dat
 * vocabulaire is uitdrukkelijk GEEN whitelist — een onbekende chip blijft
 * woordelijk staan. Een chip die de eigenaar zelf typte (of die uit de
 * AI-parse komt) hoort daarom óók op het scherm, en niet stil verdwenen.
 *
 * ── ONBEKEND IS GEEN LEEG, OOK HIER NIET ────────────────────────────
 * Een `persona` die we niet konden lezen is niet "een agent zonder rol": de
 * kolom wordt op de lijstroute juist GESTRIPT (`agentCrud.parseConfig`), en
 * `GET /agents/:id` geeft hem alleen mét `?draft=1` én bewerkrecht. Vandaar
 * `readable`, en vandaar dat de automatiseringslijst een eigen `READ`-toestand draagt:
 * een mislukte lezing van `/api/automation` is niet "deze gebruiker heeft geen
 * automations".
 */
import { isAgentCallable } from '../../../admin/Studio/SkillsStudio/skillModel';
import { READ } from '../canUse/canUseFacts';

export { READ };

/** Spiegel van personaPrompt.LIMITS. Boven deze grenzen knipt de server. */
export const PERSONA_LIMITS = Object.freeze({
    who: 600,
    toneText: 400,
    chip: 60,
    chips: 12,
    bullet: 300,
    bullets: 20,
    freeText: 20000,
});

/** Spiegel van personaPrompt.PERSONA_MODES / UNKNOWN_MODES. */
export const PERSONA_MODES = Object.freeze(['fields', 'free']);
export const UNKNOWN_MODES = Object.freeze(['honest', 'web', 'handoff']);

/**
 * De vijf toonchips die de kaart aanbiedt, in artboardvolgorde. Waarden, geen
 * labels — zie de kop.
 */
export const TONE_CHIPS = Object.freeze([
    'formal',
    'friendly',
    'concise',
    'amounts in euros',
    'Dutch unless asked otherwise',
]);

/** De chip die iets over TAAL zegt; botst met een harde `persona.language`. */
export const TONE_CHIP_LANGUAGE = 'Dutch unless asked otherwise';

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Tekst, geknipt — spiegel van `_text` in personaPrompt.js, inclusief het
 * weghalen van stuurtekens en het platslaan van regeleindes in een enkelregelig
 * veld. Zonder dat laatste levert één geplakte alinea in een bullet op het
 * scherm iets anders op dan wat er wordt opgeslagen.
 */
export function clampText(value, max, { multiline = false } = {}) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    let s = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\r\n]+/g, ' ');
    s = s.replace(/[ \t]+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
}

/** Spiegel van `_list`: geknipt, leeg eruit, hoofdletter-ongevoelig ontdubbeld, gecapt. */
export function clampList(value, { max, itemMax }) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const s = clampText(raw, itemMax);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/** De persona waar een onleesbare waarde op landt. Vers object per aanroep. */
export function emptyPersona() {
    return {
        who: '',
        tone: { chips: [], text: '' },
        does: [],
        doesNot: [],
        unknown: { mode: 'honest', automationId: null },
        language: null,
        mode: 'fields',
        freeText: '',
    };
}

/**
 * Wat er in de kolom staat, in de volle vorm.
 *
 * STRUCTUREEL, niet klemmend — en dat is een bewuste asymmetrie met de server.
 * De server is de enige schrijver van deze kolom en normaliseert bij élke
 * opslag, dus wat hier binnenkomt is al geknipt en al ontdubbeld; het nog eens
 * doen levert niets op en kost wél iets: `clampText` haalt spaties weg, en een
 * leesfunctie die "hallo " tot "hallo" maakt terwijl iemand tikt duwt de
 * cursor terug. Geknipt wordt er daarom alleen wáár de gebruiker iets kan
 * verliezen dat hij zelf heeft ingetypt — bij de bullets (`addBullet`,
 * `editBullet`) en bij de chips — plus met `maxLength` op de tekstvakken.
 *
 * Wat hier wél gebeurt is VERSMALLEN: een onbekende `unknown.mode` wordt
 * `'honest'` (de smalste: belooft niets, pakt niets) en een onbekende
 * `mode` wordt `'fields'`, precies zoals `normalisePersona` op de server.
 *
 * `readable` is het antwoord op "stond hier iets dat we konden lezen" en NIET
 * op "staat er iets in de velden". Een agent van vóór A1c heeft een lege
 * persona die wél gelezen is; een lijstrij heeft er géén, want die route
 * strippt de kolom. Die twee mogen niet hetzelfde scherm opleveren.
 *
 * @returns {{persona: object, readable: boolean}}
 */
export function personaShape(raw) {
    const persona = emptyPersona();
    let input = raw;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = null; } }
    if (!isPlainObject(input)) return { persona, readable: false };

    persona.who = typeof input.who === 'string' ? input.who : '';

    const tone = isPlainObject(input.tone) ? input.tone : {};
    persona.tone = {
        chips: Array.isArray(tone.chips) ? tone.chips.filter(c => typeof c === 'string' && c) : [],
        text: typeof tone.text === 'string' ? tone.text : '',
    };

    // GEKLEMD, anders dan de tekstvelden hierboven. De reden is niet de server
    // maar de INDEX: `BulletsCard` tekent deze lijst en geeft posities terug,
    // terwijl `removeBullet`/`editBullet` op de geklemde lijst werken. Waren
    // dat twee verschillende lijsten, dan wees regel 3 op het scherm naar
    // regel 2 in de mutatie — `removeBullet(['a','A','b'], 2)` haalde dan 'A'
    // weg in plaats van 'b'. Bereikbaar zodra iets anders dan deze kaart een
    // lijst in de persona zet (een parse-antwoord, een refine-merge, een
    // import), dus de twee lijsten zijn hier één lijst.
    persona.does = clampList(input.does, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    persona.doesNot = clampList(input.doesNot, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });

    const unknown = isPlainObject(input.unknown) ? input.unknown : {};
    const mode = UNKNOWN_MODES.includes(unknown.mode) ? unknown.mode : 'honest';
    const automationId = mode === 'handoff' ? clampText(unknown.automationId, 128) : '';
    persona.unknown = { mode, automationId: automationId || null };

    persona.language = typeof input.language === 'string' && input.language ? input.language : null;
    persona.mode = PERSONA_MODES.includes(input.mode) ? input.mode : 'fields';
    persona.freeText = persona.mode === 'free' && typeof input.freeText === 'string' ? input.freeText : '';

    return { persona, readable: true };
}

// ── Schrijven ───────────────────────────────────────────────────────
//
// Elke helper geeft een VOLLEDIGE nieuwe persona terug, niet een patch. De
// server leest een ontbrekende `persona` als "laat de kolom staan"
// (routes/agents/crud.js), dus een half object opsturen zou een veld dat
// iemand net leegmaakte stilletjes laten staan.

/** Een kopie van `persona` met `patch` erover, in de volle vorm. */
export function patchPersona(persona, patch) {
    const base = personaShape(persona).persona;
    return personaShape({ ...base, ...patch }).persona;
}

/**
 * Zitten alle twaalf chipplaatsen vol? Boven de twaalfde gooit
 * `normalisePersona` de rest weg zonder iets te zeggen; de kaart schakelt de
 * uit-staande chips daarom uit in plaats van een klik te laten verdampen.
 */
export function toneChipsFull(persona) {
    return personaShape(persona).persona.tone.chips.length >= PERSONA_LIMITS.chips;
}

/**
 * Zet één toonchip aan of uit. Uitzetten mag altijd; aanzetten kan niet meer
 * als de twaalf vol zijn — dan gebeurt er niets, en `toneChipsFull` zorgt dat
 * die knop dan al uit staat.
 */
export function toggleToneChip(persona, chip) {
    const base = personaShape(persona).persona;
    const value = clampText(chip, PERSONA_LIMITS.chip);
    if (!value) return base;
    const on = base.tone.chips.some(c => c.toLowerCase() === value.toLowerCase());
    if (!on && base.tone.chips.length >= PERSONA_LIMITS.chips) return base;
    const chips = on
        ? base.tone.chips.filter(c => c.toLowerCase() !== value.toLowerCase())
        : [...base.tone.chips, value];
    return patchPersona(base, { tone: { ...base.tone, chips } });
}

/**
 * De chips zoals de kaart ze tekent: eerst de vijf die de kaart AANBIEDT, dan
 * wat de eigenaar (of de AI-parse) er zelf bij zette. Die tweede groep hoort
 * er echt bij te staan — de server bewaart hem woordelijk en rendert hem in
 * het prompt, dus hem niet tekenen zou de instructie verzwijgen.
 *
 * @returns {Array<{value: string, on: boolean, offered: boolean}>}
 */
export function toneChipRows(persona) {
    const base = personaShape(persona).persona;
    const on = new Set(base.tone.chips.map(c => c.toLowerCase()));
    const offered = TONE_CHIPS.map(value => ({ value, on: on.has(value.toLowerCase()), offered: true }));
    const known = new Set(TONE_CHIPS.map(c => c.toLowerCase()));
    const own = base.tone.chips
        .filter(c => !known.has(c.toLowerCase()))
        .map(value => ({ value, on: true, offered: false }));
    return [...offered, ...own];
}

/**
 * Botst de taalregel met de zachte taalchip?
 *
 * `persona.language` rendert een ABSOLUTE regel ("Always write your replies in
 * X, whatever language the question is in", personaPrompt.js), en de chip zegt
 * "tenzij anders gevraagd". Staan ze allebei aan, dan bevat het prompt twee
 * instructies die elkaar tegenspreken, en niemand ziet dat — de taal staat in
 * de hero en de chip staat hier.
 */
export function toneLanguageClash(persona) {
    const base = personaShape(persona).persona;
    if (!base.language) return false;
    return base.tone.chips.some(c => c.toLowerCase() === TONE_CHIP_LANGUAGE.toLowerCase());
}

/**
 * Een bullet toevoegen. Geeft `{list, rejected}` terug: `rejected` zegt WAAROM
 * er niets veranderde, als code — `'empty'`, `'duplicate'` of `'full'`. De
 * server gooit alle drie stilzwijgend weg; hier krijgt de gebruiker het te
 * horen vóór hij denkt dat het gelukt is.
 */
export function addBullet(bullets, value) {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    const text = clampText(value, PERSONA_LIMITS.bullet);
    if (!text) return { list: current, rejected: 'empty' };
    if (current.some(b => b.toLowerCase() === text.toLowerCase())) return { list: current, rejected: 'duplicate' };
    if (current.length >= PERSONA_LIMITS.bullets) return { list: current, rejected: 'full' };
    return { list: [...current, text], rejected: null };
}

/**
 * Een bullet vervangen; leeg maken verwijdert hem (zoals de server hem zou
 * wegknippen). Zelfde vorm als `addBullet`: `{list, rejected}`.
 *
 * `'duplicate'` is de reden dat deze functie een reden HEEFT. Klemmen na de
 * vervanging ontdubbelt hoofdletter-ongevoelig en houdt de eerste treffer, dus
 * een regel bewerken naar iets dat al in de lijst staat liet er twee in gaan en
 * één uit komen — de regel die je bewerkte was weg, zonder één woord op het
 * scherm. Dat is precies de stille verdwijning waar deze kaart tegen bestaat,
 * dan door de kaart zelf gedaan. Nu verandert er niets en zegt de kaart waarom.
 */
export function editBullet(bullets, index, value) {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { list: current, rejected: 'missing' };
    }
    const text = clampText(value, PERSONA_LIMITS.bullet);
    if (!text) {
        const next = current.slice();
        next.splice(index, 1);
        return { list: next, rejected: null };
    }
    const clash = current.findIndex(b => b.toLowerCase() === text.toLowerCase());
    if (clash !== -1 && clash !== index) return { list: current, rejected: 'duplicate' };
    const next = current.slice();
    next[index] = text;
    return { list: next, rejected: null };
}

/** Een bullet verwijderen. */
export function removeBullet(bullets, index) {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return current;
    const next = current.slice();
    next.splice(index, 1);
    return next;
}

// ── De hand-off-automation ─────────────────────────────────────────────

/**
 * Mag deze bewerker een hand-off-automation kiezen?
 *
 * `verifyHandoffAutomation` (routes/agents/crud.js) toetst de automatisering tegen
 * `agent.owner_id`, terwijl `GET /api/automation` de automatiseringen van de INGELOGDE
 * gebruiker teruggeeft. Bewerkt een org-admin andermans agent, dan toont de
 * kiezer dus automatiseringen die de server gegarandeerd weigert — en een keuze
 * aanbieden die zeker sneuvelt is de stille vorm van niets doen.
 *
 * Onbekend versmalt: zonder allebei de ids weten we niet of dit dezelfde
 * persoon is, en dan wordt er niet gekozen.
 *
 * @returns {null|'not_owner'|'unknown_owner'} null = kiezen mag.
 */
export function handoffBlockedBecause({ agentOwnerId, userId }) {
    const owner = typeof agentOwnerId === 'string' && agentOwnerId ? agentOwnerId : null;
    const me = typeof userId === 'string' && userId ? userId : null;
    if (!owner || !me) return 'unknown_owner';
    return owner === me ? null : 'not_owner';
}

/**
 * De automatiseringen die als hand-off in aanmerking komen.
 *
 * De poort is `trigger.kind === 'agent_call'` — dezelfde die
 * `automationToTool` (server/automation/agentCallableTools.js) hanteert, want
 * dat is de enige soort die de runtime als actie aanbiedt. Uitgeschakelde
 * automatiseringen worden NIET weggefilterd maar gemarkeerd (`active: false`): ze
 * staan in de lijst van de gebruiker, de server weigert ze, en verzwijgen
 * levert alleen "waar is mijn automation gebleven".
 *
 * `state` reist mee — met één correctie. Een `READ.OK` met iets dat GEEN lijst
 * is, is geen lege lijst maar een ONLEESBAAR antwoord, en dat wordt hier
 * `READ.ERROR`. Zonder die versmalling zei de kaart "No automatisering can be started
 * by an agent yet" op precies de invoer die de standaardwaarden opleveren
 * (`automations = null, automationsState = READ.OK`) — terwijl `selectedHandoff`
 * hiernaast en `toolGrants.automationRows` hiernaast dezelfde invoer wél als
 * onleesbaar lezen. Eén kaart die zichzelf tegenspreekt is erger dan een kaart
 * die zegt dat ze het niet weet.
 *
 * @returns {{rows: Array<{id,title,active}>, state: string}}
 */
export function handoffChoices({ automations, state = READ.OK }) {
    if (state !== READ.OK) return { rows: [], state };
    if (!Array.isArray(automations)) return { rows: [], state: READ.ERROR };
    const rows = automations
        .filter(a => a && typeof a.id === 'string' && a.id && isAgentCallable(a))
        .map(a => ({
            id: a.id,
            title: typeof a.title === 'string' && a.title
                ? a.title
                : (typeof a.name === 'string' && a.name ? a.name : null),
            active: a.isActive === true || a.is_active === true,
        }));
    return { rows, state };
}

/**
 * De gekozen automatisering, zoals de kaart hem moet tekenen.
 *
 * Nooit `null` bij een gezet id: een automatisering die we niet kunnen benoemen is
 * `readable: false` en blijft staan mét zijn id. Hem weglaten zou beweren dat
 * er geen hand-off is, terwijl de server hem wel degelijk kan verifiëren.
 *
 * @returns {null|{id, title, readable, active, callable}}
 */
export function selectedHandoff({ automations, state = READ.OK, automationId }) {
    const id = clampText(automationId, 128);
    if (!id) return null;
    const index = state === READ.OK && Array.isArray(automations)
        ? new Map(automations.filter(a => a && typeof a.id === 'string').map(a => [a.id, a]))
        : null;
    const found = index ? index.get(id) : null;
    if (!found) return { id, title: null, readable: false, active: null, callable: null };
    return {
        id,
        title: typeof found.title === 'string' && found.title
            ? found.title
            : (typeof found.name === 'string' && found.name ? found.name : null),
        readable: true,
        active: found.isActive === true || found.is_active === true,
        callable: isAgentCallable(found),
    };
}
