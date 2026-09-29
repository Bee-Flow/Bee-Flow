/**
 * MET WELK SJABLOON IS DEZE SAMENVATTING GESCHREVEN — de pure helft
 * (plan M4 stap 3, "Sjabloon (v4)").
 *
 * De server stempelt een notitie bij het schrijven van de samenvatting:
 * `summaryTemplateId` ('builtin:<sleutel>' of het id van een opgeslagen
 * sjabloon) en `summaryTemplateVersion`. Deze functie zet dat paar om in een
 * TOESTAND — geen zin. De zin (en dus het meervoud, de volgorde, de vertaling)
 * hoort in de opmaak, want een sleutelkeuze is geen stringkeuze.
 *
 * ── DE VERSIE KOMT VAN DE NOTITIE, NOOIT VAN HET SJABLOON ────────────
 * Het sjabloon staat vandaag misschien op v9 terwijl deze notitie met v2
 * geschreven is. De versie van de RIJ tonen zou een uitspraak over het
 * verleden zijn die aan het heden is afgelezen — precies de stille onwaarheid
 * die dit programma steeds tegenkomt. De rij levert alleen de NAAM.
 *
 * ── VIJF TOESTANDEN, EN VIER ERVAN ZWIJGEN LIEVER ────────────────────
 * `NONE`     de notitie draagt geen (leesbare) stempel — o.a. elke notitie van
 *            vóór deze kolommen, en elke samenvatting die met een eenmalige
 *            prompt geschreven is. Toon niets. NIET "v1": een versienummer
 *            verzinnen voor een notitie waarvan je het sjabloon niet kent is
 *            een bewering die niemand ooit heeft gecontroleerd.
 * `LOADING`  er ís een stempel, maar de sjabloonlijst is nog niet binnen (of
 *            niet te lezen). Dan is de naam onbekend — zwijgen, en zeker niet
 *            "bestaat niet meer" zeggen over een sjabloon dat er gewoon is.
 * `BUILTIN`  een ingebouwd sjabloon. Die leven in code, niet in een tabel: er
 *            is geen versie, en er wordt er geen verzonnen.
 * `CUSTOM`   een opgeslagen sjabloon dat de lezer nog kan zien — naam uit de
 *            lijst, versie uit de notitie.
 * `GONE`     een stempel waarvan het sjabloon niet in de lijst staat:
 *            verwijderd, of niet meer zichtbaar voor deze lezer. We weten
 *            wélke versie, maar niet welke naam — en dan wordt er geen naam
 *            geraden. Welke van die twee het is, valt hier NIET vast te
 *            stellen: de lijst is die van de lezer. De zin eromheen
 *            (detail/SummaryView.jsx) mag daarom geen verwijdering beweren —
 *            voor elke gedeelde notitie die met een persoonlijk sjabloon
 *            geschreven is, is de tweede lezing de gewone.
 */

/** Zo markeert de server een ingebouwd sjabloon (core/meetingNotes/summaryStamp.js). */
export const BUILTIN_STAMP_PREFIX = 'builtin:';

export const SUMMARY_STAMP = Object.freeze({
    NONE: 'none',
    LOADING: 'loading',
    BUILTIN: 'builtin',
    CUSTOM: 'custom',
    GONE: 'gone',
});

const NOTHING = Object.freeze({ state: SUMMARY_STAMP.NONE, name: null, nameKey: null, version: null });

/** Een bruikbare, niet-lege naam? */
function nonEmpty(v) {
    return typeof v === 'string' && v.trim() !== '';
}

/** Een versienummer, of null. Alles wat geen positief geheel getal is telt niet. */
function readVersion(raw) {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Lees de stempel van een notitie.
 *
 * @param {object|null} meeting detail-payload; alleen `summaryTemplateId` en
 *        `summaryTemplateVersion` worden gelezen.
 * @param {object|null} templates het antwoord van GET /api/summary-templates
 *        (`{ builtins, custom }`); `null`/onleesbaar = nog niet bruikbaar.
 * @returns {{state: string, name: string|null, nameKey: string|null, version: number|null}}
 */
function builtinStamp(key, templates) {
    const builtins = Array.isArray(templates?.builtins) ? templates.builtins : null;
    // Zonder lijst geen naam. Zwijgen, niet gokken.
    if (!builtins) return { state: SUMMARY_STAMP.LOADING, name: null, nameKey: null, version: null };
    const hit = builtins.find((b) => b && b.id === key);
    // Geen rij, of een rij zonder bruikbare naam: allebei "we kunnen dit
    // sjabloon niet noemen". Een lege naam invullen zou "Template: " op het
    // scherm zetten — een zin met een gat erin.
    if (!hit || !(nonEmpty(hit.name) || nonEmpty(hit.nameKey))) {
        return { state: SUMMARY_STAMP.GONE, name: null, nameKey: null, version: null };
    }
    // Ingebouwd = geen versie, ook niet als de notitie er toch een draagt.
    return {
        state: SUMMARY_STAMP.BUILTIN,
        name: nonEmpty(hit.name) ? hit.name.trim() : null,
        nameKey: nonEmpty(hit.nameKey) ? hit.nameKey.trim() : null,
        version: null,
    };
}

function customStamp(id, templates, version) {
    const custom = Array.isArray(templates?.custom) ? templates.custom : null;
    if (!custom) return { state: SUMMARY_STAMP.LOADING, name: null, nameKey: null, version };
    const hit = custom.find((c) => c && c.id === id);
    // Weg of onzichtbaar: de versie weten we nog uit de notitie, de naam niet.
    if (!hit || !nonEmpty(hit.name)) return { state: SUMMARY_STAMP.GONE, name: null, nameKey: null, version };
    // De naam van NU (die verandert bij hernoemen zonder de tekst te raken),
    // de versie van TOEN.
    return { state: SUMMARY_STAMP.CUSTOM, name: hit.name.trim(), nameKey: null, version };
}

export function buildSummaryStamp(meeting, templates) {
    const raw = meeting?.summaryTemplateId;
    if (typeof raw !== 'string' || !raw.trim()) return { ...NOTHING };
    const id = raw.trim();
    const version = readVersion(meeting?.summaryTemplateVersion);

    if (!id.startsWith(BUILTIN_STAMP_PREFIX)) return customStamp(id, templates, version);
    const key = id.slice(BUILTIN_STAMP_PREFIX.length);
    if (!key) return { ...NOTHING };
    return builtinStamp(key, templates);
}
