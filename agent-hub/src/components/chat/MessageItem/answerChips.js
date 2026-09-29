/**
 * De chiprij onder één antwoord — wélke chips, en van welke SOORT bewering.
 *
 * ── EEN CHIP IS EEN BEWERING, EN ZE ZIJN NIET ALLEMAAL EVEN STERK ──────────
 *
 * Een chip zegt: dit antwoord komt hiervandaan. Drie van de vier soorten hier
 * zijn OPGETEKEND — de server schreef een event terwijl het antwoord gemaakt
 * werd, en er zit iets achter dat je terug kunt lezen:
 *
 *   kennisbank   `kb_sources` → `msg.kbSources`, de passage zit erin
 *   tabelrij     hetzelfde event, `kind: 'datatable_row'` — een rij die op het
 *                moment van de vraag uit de tabel is gelezen
 *   skill        `session_skill_completed` → de snapshot op het bericht
 *
 * De vierde niet. "Regel gevolgd: …" komt uit een attributie-pass
 * (`server/core/agentRuntime/ruleAttribution.js`): een tweede model heeft ná
 * afloop de rol naast het antwoord gelegd en er iets van gevonden. Dat is een
 * MENING over dezelfde vraag, en ze mag niet als notulen op het scherm komen.
 *
 * Dus krijgt elke chip hier een `grade`, en houdt `AnswerChips.jsx` die twee
 * uit elkaar in vorm, in volgorde en in woorden:
 *
 *   'recorded'  de beurt heeft dit opgeschreven
 *   'judged'    iemand heeft dit achteraf beweerd
 *
 * Ze door elkaar in één uniforme pil gooien zou het zwakste bewijs in de rij
 * het gewicht van het sterkste geven — en dat is precies de verkeerde kant op:
 * wie een chip ziet, gelooft de rij, niet de chip.
 *
 * ── WAT ER NIET IN KOMT ────────────────────────────────────────────────────
 *
 *   • Een skill die alleen AANSTOND. Actief betekent "was beschikbaar", en dat
 *     is geen herkomst. Alleen wat afliep (`completedSkillIds`) heeft aan dit
 *     antwoord meegewerkt.
 *   • Een skill die we niet bij naam kennen. Een chip met een id erin is geen
 *     bewering die iemand kan lezen; onbekend versmalt.
 *   • Wat dan ook als de attributie-pass niets stuurde. Geen chip is geen
 *     bewering — een chip die "geen regel gevolgd" zou zeggen is er wél een,
 *     en juist uit de bron die zojuist bewees niets te kunnen zeggen.
 *
 * Zuiver: geen React, geen t(), geen DOM. Zodat "welke chip mag hier staan"
 * met platte objecten te testen is.
 */

import { groupByDocument } from './citationGroups';

/** De beurt heeft dit opgeschreven; er zit iets achter om na te lezen. */
export const GRADE_RECORDED = 'recorded';
/** Iemand heeft dit achteraf beweerd. Nooit dezelfde pil als hierboven. */
export const GRADE_JUDGED = 'judged';
/** De twee soorten bewering. De volgorde is de rendervolgorde. */
export const CHIP_GRADES = Object.freeze([GRADE_RECORDED, GRADE_JUDGED]);

/** Hoeveel geoordeelde chips er hoogstens onder één antwoord passen. */
export const MAX_JUDGED_CHIPS = 6;
/**
 * Hoeveel OPGETEKENDE chips er hoogstens onder één antwoord staan.
 *
 * Dezelfde maat als hierboven, en om dezelfde reden. Die helft was ongegrensd
 * terwijl de geoordeelde helft op zes stond, en dat pakt precies verkeerd uit:
 * `kbSources` STAPELT over alle toolrondes van één beurt (sseEvents merget in
 * plaats van te vervangen) en één `datatable_query` levert tot MAX_ROW_LIMIT =
 * 50 citaten. Eén tabelvraag maakte de rij die als bewijs bedoeld is dus een
 * muur van vijftig altijd-uitgeklapte pillen, met de geoordeelde chip die je
 * juist apart wilde zien eronder weggeschoven.
 *
 * De rest verdwijnt niet: er komt een telpil "+N more" achter, net zoals
 * `HowIGotThisAnswer` de volledige lijst achter een dichtgeklapte `<details>`
 * met een telpil zet. Weglaten zonder het te zeggen zou van een begrenzing een
 * onwaarheid maken.
 */
export const MAX_RECORDED_CHIPS = 6;

/** Een niet-lege, getrimde string, of null. */
function text(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/**
 * De citaten van deze beurt: kennisbankpassages én live tabelrijen.
 *
 * Ze reizen door hetzelfde event en dragen dezelfde vorm
 * (`server/core/kb/citation.js`), dus ze blijven hier ook samen — `CitationChips`
 * maakt van de soort een glyph. Alles zonder titel én zonder inhoud valt weg:
 * dat is geen citaat maar een lege plek met een randje.
 */
export function citationChipsOf(msg) {
    const sources = Array.isArray(msg?.kbSources) ? msg.kbSources : [];
    const cited = sources.filter(s => s && (text(s.title) || text(s.content)));
    // One chip per DOCUMENT, not per passage (BFSF-352): several passages of
    // one meeting note used to render as a row of identical chips. The chip
    // stands for the document, opens its best passage, and says how many
    // passages it folds (`passageCount`, only when more than one).
    return groupByDocument(cited).map(({ best, passages }) => (
        passages.length > 1 ? { ...best, passageCount: passages.length } : best
    ));
}

/**
 * Valt er achter deze chip iets OPEN te doen? (C13)
 *
 * Een citaatchip opent `CitationOverlay`, en die overlay toont precies één
 * ding: `source.content`, de passage zelf. Ontbreekt die, dan opent de chip
 * een paneel dat "No content preview available" zegt — een klik die belooft
 * dat je het na kunt lezen en dan niets laat zien.
 *
 * En ontbreken gebeurt écht: niet elke emitter stuurt de passage mee
 * (`routes/ai/webpageChat.js` stuurt alleen `preview`), en een server kan hem
 * hebben weggelaten omdat déze lezer de bron niet mag lezen. Die twee zijn
 * van deze kant NIET uit elkaar te houden — en juist daarom is dit de veilige
 * kant op: onbekende leesbaarheid versmalt naar NIET-klikbaar. De chip zelf
 * blijft staan (het antwoord heeft die bron gebruikt, dat verzwijgen we niet),
 * hij is alleen geen knop.
 *
 * `preview` telt bewust NIET mee. Dat is de alias van één release
 * (`core/kb/citation.js`) en de overlay leest hem niet; hem hier goedkeuren
 * zou precies de lege overlay opleveren die deze functie voorkomt.
 */
export function citationIsOpenable(source) {
    return text(source?.content) !== null;
}

/**
 * De skills die tijdens deze beurt zijn AFGELOPEN, met hun naam.
 *
 * De catalogus (`sessionSkills`) levert de naam; een voltooid id dat er niet
 * in staat valt weg. Ontdubbeld, in de volgorde van de catalogus, zodat twee
 * beurten met dezelfde skills dezelfde rij tonen.
 */
export function skillChipsOf(msg, sessionSkills) {
    const catalogue = Array.isArray(sessionSkills) ? sessionSkills : [];
    if (catalogue.length === 0) return [];
    const snap = msg?.sessionSkillsSnapshot;
    const completed = Array.isArray(snap?.completedSkillIds) ? snap.completedSkillIds : [];
    if (completed.length === 0) return [];
    const done = new Set(completed);
    const out = [];
    for (const skill of catalogue) {
        if (!skill || !done.has(skill.id)) continue;
        const name = text(skill.name);
        if (!name) continue;
        out.push({ id: skill.id, name, icon: text(skill.icon) });
    }
    return out;
}

/**
 * De regels die de attributie-pass als gevolgd aanwees.
 *
 * De server stuurt alleen `followed` (zie `ruleAttribution.js`), maar deze
 * kant leest dat niet op goed vertrouwen: alles wat geen bruikbare regeltekst
 * is, valt weg, en zonder event is de lijst leeg. Geen event, geen chip, geen
 * uitspraak over het ontbreken ervan.
 */
export function ruleChipsOf(msg) {
    const rules = msg?.ruleAttribution?.rules;
    if (!Array.isArray(rules)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of rules) {
        const rule = text(typeof entry === 'string' ? entry : entry?.rule);
        if (!rule || seen.has(rule)) continue;
        seen.add(rule);
        out.push({ rule });
        if (out.length >= MAX_JUDGED_CHIPS) break;
    }
    return out;
}

/**
 * Alles bij elkaar, in rendervolgorde: eerst wat opgetekend is, dan wat
 * beweerd wordt. Nooit door elkaar — de volgorde is een van de dragers van
 * het verschil.
 *
 * `showSources` is FAIL-CLOSED: weglaten betekent hier `false`, niet `true`.
 * Een toekomstige aanroeper die de prop vergeet hoort niets te tonen in plaats
 * van alles — dezelfde invariant die `HowIGotThisAnswer` in zijn kop vastlegt.
 * De productdefault ("binnen het product is die transparantie juist het punt")
 * hoort thuis op `MessageItem`, dat de prop expliciet doorgeeft.
 *
 * `showProcess` is een andere soort schakelaar, en daarom géén poort: hij
 * zegt niet wie iets mag zien maar WELKE HELFT van de rij dit scherm toont.
 * De gewone chat toont sinds C6 de bronchips — dáár gaat het antwoord over —
 * en laat de verantwoording over hoe de beurt liep (welke skills afliepen,
 * welke regel een tweede model achteraf herkende) aan de testchat in de
 * bouwer, die er expliciet om vraagt. Vandaar de default `true`: deze functie
 * rapporteert wat er IS; het versmallen gebeurt op de aanroepplek, en
 * `MessageItem` geeft hem door als `showAnswerChips`.
 *
 * `showSources: false` haalt de CITATEN eruit en laat de rest staan. Dat is
 * dezelfde schakelaar die `HowIGotThisAnswer` al krijgt, en hij hoort hier ook
 * te gelden: een citaatchip draagt een documenttitel, een paginanummer en via
 * `chipTitle` ook de kop van de passage — iemands handboek op het scherm van
 * een vreemde. De skill- en regelchips dragen dat niet en blijven. Onbekend
 * versmalt: alles wat niet letterlijk `true` is, is geen toestemming.
 *
 * @param {object} msg
 * @param {object} [opts]
 * @param {Array}  [opts.sessionSkills] de skillcatalogus van deze sessie
 * @param {boolean} [opts.showSources] mogen kennisbankgegevens op dit scherm?
 * @param {boolean} [opts.showProcess] toont dit scherm ook hoe de beurt liep?
 * @returns {{citations: Array, citationsHidden: number, skills: Array,
 *            rules: Array, hasRecorded: boolean, hasJudged: boolean,
 *            isEmpty: boolean}}
 */
export function answerChipsFor(msg, { sessionSkills, showSources = false, showProcess = true } = {}) {
    const allCitations = showSources === true ? citationChipsOf(msg) : [];
    const citations = allCitations.slice(0, MAX_RECORDED_CHIPS);
    const citationsHidden = Math.max(0, allCitations.length - citations.length);
    const skills = showProcess === false ? [] : skillChipsOf(msg, sessionSkills);
    const rules = showProcess === false ? [] : ruleChipsOf(msg);
    const hasRecorded = citations.length > 0 || skills.length > 0;
    const hasJudged = rules.length > 0;
    return {
        citations, citationsHidden, skills, rules,
        hasRecorded, hasJudged, isEmpty: !hasRecorded && !hasJudged,
    };
}
