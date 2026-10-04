'use strict';

/**
 * "Wat hangt er aan DEZE webpagina?" — de leeskant van W5 (deel B).
 *
 * De tegenhanger van `webpageUsageSync.js`, dat de andere richting op kijkt
 * (welke TABELLEN raakt deze pagina aan). Hier is de pagina het onderwerp:
 * welke dingen zouden stukgaan, of iets kwijtraken, als zij verdwijnt.
 *
 * Vier deelvragen, en ze zijn met opzet los van elkaar:
 *
 *   solution    de Oplossing waarin de pagina is opgeborgen (`webpages.project_id`)
 *   automation  de automatiseringen die haar bij naam noemen (`automations.definition_json`)
 *   chat        de gesprekken die haar erbij halen — NIET VASTGELEGD
 *   agent       de agents die haar als tool mogen openen — VANDAAG ONBEKEND
 *
 * ── EEN LEGE LIJST IS EEN BEWERING, GEEN LEGE PLEK ──────────────────
 *
 * "Niets gebruikt deze pagina" is de zin waarop iemand op Verwijderen drukt.
 * Die zin mag alleen klinken als alle drie de deelvragen ECHT geantwoord
 * hebben. Daarom levert dit bestand nooit alleen rijen, maar per soort een
 * stand — dezelfde scheiding die `routes/studio/attention.js` voor "Vraagt
 * aandacht" maakt, en om exact dezelfde reden: daar werd ooit "alles is in
 * orde" getoond over een graaf waarvan de helft nooit geladen was.
 *
 *   status 'checked'      de scan liep; `found` is een getal en 0 is nieuws
 *   status 'unavailable'  hij kon niet kijken; `found` is null en de soort
 *                         staat in `partial` → de client leest dat als
 *                         "ik weet het niet", nooit als "er is niets"
 *
 * `complete` is de vergunning om "niets gebruikt dit" te zeggen: alleen waar
 * als `partial` leeg is. Vandaag is dat NOOIT waar (zie `agent` hieronder), en
 * dat is de eerlijke stand — de plaatshouder in
 * `agent-hub/src/pages/webpages/WebpageUsedByTab.jsx` zegt vandaag hetzelfde
 * met woorden. Deze module vervangt die zin door een antwoord dat per soort te
 * controleren is.
 *
 * ── DE RIJEN ZIJN HET Used-by-CONTRACT ──────────────────────────────
 * `{ kind, id, title, role, ownerId, lastAt }` — wat
 * `shared/UsedByTab.jsx` rendert en `shared/DangerZone.jsx` telt, zodat het
 * tabblad, de verwijderbevestiging en de pillen niet van elkaar kunnen gaan
 * verschillen. Precies de vorm van `core/kb/kbUsage.js` en
 * `core/meetingNotes/meetingUsage.js`.
 *
 * ── WAAROM `agent` PERMANENT ONBEKEND IS ────────────────────────────
 *
 * De webpagina-tools van een agent (`integrations/webpageAutomationTools.js`)
 * nemen `webpageId` als ARGUMENT en toetsen pas bij de aanroep op
 * `canReadWebpage`. Er is dus geen enkele rij die zegt "agent X mag pagina Y
 * openen"; de bevoegdheid ontstaat op het moment zelf. Dat is iets anders dan
 * "geen enkele agent kan erbij" — het is niet te beantwoorden. Onbekend
 * versmalt, dus deze soort meldt zich als `unavailable` en houdt `complete` op
 * false, in plaats van een nul te melden waar niemand voor kan instaan.
 *
 * NIET verwarren met `bridge_grants.agent`: dat is de OMGEKEERDE richting (de
 * pagina mag die agent aanroepen). Die hoort in het Gebruikt-door van de
 * AGENT thuis — `stores/agent/agentUsage.js` scant hem daar al — en zou hier
 * een gebruiker verzinnen die er niet is.
 *
 * ── WAAROM `chat` NIET HET BOUWGESPREK IS ───────────────────────────
 *
 * Een pagina wordt op twee manieren bij een gesprek gehaald, en maar één
 * daarvan is een AFHANKELIJKHEID:
 *
 *   1. het gesprek dat AAN de pagina hangt — `webpages.chat_messages`, het
 *      bouwgesprek uit de editor. Dat staat op de rij ZELF, is van de eigenaar,
 *      en gaat mee als de pagina weg is. Het is dus geen ding dat stukgaat: het
 *      is een deel van de pagina. Het als rij melden zou vrijwel élke pagina
 *      "in gebruik" laten heten (iedere pagina die ooit via de editor-chat is
 *      gebouwd heeft die kolom gevuld), met als rij-titel de naam van de pagina
 *      waar de lezer al naar kijkt — een afhankelijkheid die niet bestaat, en
 *      een 409 met de verkeerde zin. Wat er wél mee weggaat is INHOUD, en dat
 *      is een andere vraag dan "wat gaat er stuk"; de dialoog zegt dat met
 *      "what lives on the page goes with it".
 *   2. de pagina in het zijpaneel van een gewone chat
 *      (`AgentHub/useSidePanelState.js`). Dat is PER BEURT: de client stuurt
 *      `sidePanelWebpage` mee in het verzoek, `promptAssembly.js` spuit de
 *      inhoud in de prompt, en er wordt NIETS vastgelegd — niet op het gesprek,
 *      niet op het bericht. Dát is de vraag die de soort `chat` stelt, en zij is
 *      niet te beantwoorden: er bestaat geen rij die haar draagt.
 *
 * Daarom meldt `chat` zich als `unavailable` en niet als een nul. Een nul zou
 * beweren dat er gekeken is; er valt niet te kijken. Zou een volgende release
 * die keuze wél vastleggen (een `webpage_id` op `direct_conversations`, of in
 * `conversation_messages.meta_json`), dan wordt dit een echte scan. Let op: de
 * inhoud van gesprekken is versleuteld (`stores/agent/messageCrypto.js`), dus
 * zoeken op een paginanaam of -id IN de berichten is geen alternatief — het
 * antwoord zou stil leeg blijven, wat precies de fout is die deze module
 * voorkomt.
 *
 * ── WAAROM `automation` ER WÉL IS ───────────────────────────────────
 *
 * Een automatisering bindt een pagina DUURZAAM. `automation/builderPrompt.js` zegt de
 * bouwer letterlijk: "Every webpage tool requires `webpageId` … bind it as a
 * literal", en het meegeleverde sjabloon in `automation/templates.js` doet dat
 * ook. Die id's staan in `automations.definition_json` en zijn op te vragen met
 * exact de query die dit huis voor elke andere soort schrijft — `kbUsage.js`
 * doet het zo, en `stores/agent/agentUsage.js` heeft `automation` gewoon in
 * KINDS. Zonder deze scan verdween een factuurautomatisering die elke ochtend in de
 * pagina schrijft uit élk scherm dat de vraag stelt, en faalde zij vanaf de
 * volgende run stil op `resolveWebpageForAccess`.
 *
 * Wat de scan NIET vindt is een binding via `{kind:'ref', path:…}`: dan kiest de
 * automatisering haar pagina pas tijdens de run en staat het id nergens. Dat is een
 * bewust gekozen dynamische modus, geen standaard, en de rijen die er wél zijn
 * blijven kloppen — de soort meldt zich dus als `checked`.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

/** Elke soort die dit kan vinden, in de volgorde waarin het tabblad ze toont. */
const KINDS = Object.freeze(['solution', 'automation', 'chat', 'agent']);

/**
 * Waarom een soort niet beantwoord kon worden — machinetokens, geen proza.
 *
 * Zelfde keuze als `REASONS` in webpageUsageSync.js en als `unfiltered` in
 * meetingUsage: een hier verzonnen Engelse zin komt in elke taal onvertaald
 * op het scherm. De client kiest de woorden, de server levert het feit.
 */
const REASONS = Object.freeze({
    NO_PAGE: 'no-page',
    NO_PROJECTS_TABLE: 'no-projects-table',
    NO_AUTOMATIONS_TABLE: 'no-automations-table',
    PROBE_FAILED: 'probe-failed',
    NOT_RECORDED: 'not-recorded',
    SCAN_FAILED: 'scan-failed',
});

/**
 * Bestaat deze tabel op DEZE installatie?
 *
 * Eigen kopie, net als in `core/kb/kbUsage.js` en
 * `core/meetingNotes/meetingUsage.js`: elke usage-module is een blad dat
 * alleen `db` nodig heeft, en een require dwars door een ander domein heen
 * (webpages → kb) zou een leesbaarheidswinst van zes regels kosten in
 * koppeling.
 *
 * DRIE standen, niet twee. `true` en `false` zijn antwoorden; `null` is "ik kon
 * niet kijken". Zou een omgevallen probe `false` teruggeven, dan meldde de scan
 * `no-projects-table` — een machinetoken waar de client de zin "deze installatie
 * heeft geen Oplossingen" op bouwt, en die zin is onwaar over een installatie
 * die ze wél heeft. Beide standen blokkeren de verwijdering (allebei
 * `unavailable`), maar ze vertellen de lezer iets anders.
 */
async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return null;
    }
}

/**
 * De Oplossing waarin deze pagina is opgeborgen.
 *
 * `webpages.project_id` is een ZACHTE verwijzing (geen FK, zie
 * stores/webpage/schema.js): een verwijderde Oplossing laat de pagina staan en
 * de wijzer achter. Drie uitkomsten, en ze zijn alle drie iets anders:
 *
 *   geen project_id      de pagina staat los → gecontroleerd, nul rijen. Er
 *                        wordt hier bewust NIET eerst naar de tabel gekeken:
 *                        de paginarij beantwoordt de vraag al volledig, en een
 *                        probe zou een installatie zónder Oplossingen elke
 *                        losse pagina laten melden als "niet gecontroleerd".
 *   tabel afwezig        deze installatie kent geen Oplossingen → `unavailable`
 *                        met `no-projects-table`
 *   probe omgevallen     onbekend → `unavailable` met `probe-failed`, want dat
 *                        is iets anders dan "er zijn hier geen Oplossingen"
 *   wijzer zonder rij    de Oplossing is al weg → gecontroleerd, nul rijen.
 *                        Er gaat niets stuk aan iets wat er niet meer is, en
 *                        een rij zonder naam zou een link opleveren die 404t.
 */
async function scanSolution(webpage, db) {
    const projectId = webpage.projectId || null;
    if (!projectId) return { rows: [] };
    const present = await tableExists('projects', db);
    if (present !== true) {
        return { rows: [], unchecked: present === null ? REASONS.PROBE_FAILED : REASONS.NO_PROJECTS_TABLE };
    }
    const r = await db.query(
        `SELECT id, name, owner_id, updated_at FROM projects WHERE id = $1`,
        [projectId],
    );
    const row = (r.rows || [])[0];
    if (!row) return { rows: [] };
    return {
        rows: [{
            kind: 'solution',
            id: row.id,
            title: row.name || null,
            // De Oplossing BEVAT de pagina — dezelfde rol die kbUsage voor
            // `projects` gebruikt, zodat één werkwoord één ding betekent.
            role: 'contains',
            ownerId: row.owner_id || null,
            lastAt: row.updated_at || null,
        }],
    };
}

/**
 * Automatiseringen die deze pagina bij naam noemen.
 *
 * De id's zitten op onbekende diepte in `definition_json` (een stap-argument,
 * een quick-mode-veld, een sjabloon), dus de containment-operator kan niet —
 * `jsonb_path_exists` met een recursieve wildcard is de ene vorm die ze vindt
 * waar een editor ze ook heeft neergezet. Exact de query die
 * `core/kb/kbUsage.js` voor dezelfde vraag schrijft.
 *
 * Twee vormen, want de bouwer schrijft de gebonden variant en oudere
 * definities de kale: `{webpageId: {kind:'literal', value:'wp_1'}}` en
 * `{webpageId: 'wp_1'}`.
 *
 * Het id gaat via de VARS-parameter van jsonpath naar binnen, nooit
 * geconcateneerd in het pad. Een webpagina-id is een route-parameter, en een
 * waarde met een aanhalingsteken zou anders de stringliteraal IN het jsonpath
 * sluiten en als padsyntax worden gelezen — placeholder of niet, de injectie
 * zit dan in het pad en niet in de SQL.
 */
async function scanAutomation(webpage, db) {
    const present = await tableExists('automations', db);
    if (present !== true) {
        return { rows: [], unchecked: present === null ? REASONS.PROBE_FAILED : REASONS.NO_AUTOMATIONS_TABLE };
    }
    const r = await db.query(
        `SELECT id, title, user_id AS owner_id, updated_at AS last_at
           FROM automations
          WHERE jsonb_path_exists(definition_json, '$.**.webpageId.value ? (@ == $id)', jsonb_build_object('id', $1::text))
             OR jsonb_path_exists(definition_json, '$.**.webpageId ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        [webpage.id],
    );
    return {
        rows: (r.rows || []).map(row => ({
            kind: 'automation',
            id: row.id,
            title: row.title || null,
            // Een automatisering LEEST de pagina en schrijft in haar database
            // (`webpage_db_exec`, `webpage_file_write`) — dezelfde rol die de
            // index voor een schrijvende binding gebruikt.
            role: 'readwrite',
            ownerId: row.owner_id || null,
            lastAt: row.last_at || null,
        })),
    };
}

/**
 * Gesprekken die deze pagina erbij halen — zie de kop: niet vastgelegd.
 *
 * Bewust GEEN scan over `webpages.chat_messages`. Dat is het bouwgesprek van de
 * pagina zelf: het staat op dezelfde rij, gaat mee als de pagina weg is, en kan
 * dus per definitie niet stukgaan aan de verwijdering. Het als afhankelijkheid
 * melden liet vrijwel elke pagina "in gebruik" heten, met als rij-titel de naam
 * van de pagina waar de lezer al naar keek.
 *
 * De vraag die hier hoort — welke gewone gesprekken hebben deze pagina in hun
 * zijpaneel — heeft geen rij die haar draagt: `sidePanelWebpage` reist per beurt
 * mee in het verzoek en wordt nergens opgeslagen. Onbekend versmalt, dus geen
 * nul.
 */
async function scanChat() {
    return { rows: [], unchecked: REASONS.NOT_RECORDED };
}

/**
 * Agents die deze pagina als tool mogen openen — zie de kop: niet vast te
 * stellen. Geen query, geen rijen, en met opzet ook geen nul.
 */
async function scanAgent() {
    return { rows: [], unchecked: REASONS.NOT_RECORDED };
}

const SCANS = Object.freeze({
    solution: scanSolution,
    automation: scanAutomation,
    chat: scanChat,
    agent: scanAgent,
});

/**
 * Alles wat aan deze webpagina hangt.
 *
 * @param {object} webpage  de PAGINARIJ zoals de store hem teruggeeft, niet
 *                          alleen haar id: `projectId` is wat `scanSolution`
 *                          leest, en zonder die eigenschap meldt hij
 *                          "gecontroleerd, nul rijen" voor een pagina die wél
 *                          in een Oplossing ligt — een echte afhankelijkheid
 *                          die als een BEVESTIGDE nul uit de lijst valt in
 *                          plaats van als een gat. `id` draagt de rest.
 * @param {object} [opts]
 * @param {object} [opts.db]  injectiepunt voor de tests
 * @returns {Promise<{rows: Array, partial: string[], sources: object, complete: boolean}>}
 *          `partial` noemt de soorten die NIET beantwoord konden worden. Niet
 *          leeg betekent "ik weet het niet" — nooit "er is niets".
 */
async function usageForWebpage(webpage, { db = pool } = {}) {
    const rows = [];
    const partial = [];
    const sources = {};

    // Zonder pagina is er niets gevraagd én niets beweerd. Nul rijen mét drie
    // onbeantwoorde soorten, want een aanroeper die hier per ongeluk `null`
    // binnenkrijgt mag daar geen schone verwijdering uit lezen.
    if (!webpage || webpage.id == null || webpage.id === '') {
        for (const kind of KINDS) {
            sources[kind] = { status: 'unavailable', found: null, reason: REASONS.NO_PAGE };
            partial.push(kind);
        }
        return { rows, partial, sources, complete: false };
    }

    for (const kind of KINDS) {
        try {
            const out = await SCANS[kind](webpage, db);
            const found = Array.isArray(out?.rows) ? out.rows : [];
            // Gevonden rijen blijven staan, óók als de soort onbeantwoord is:
            // ze zijn echt, en weggooien zou een bestaande afhankelijkheid
            // verbergen. Wat dan niet meer klopt is het AANTAL — vandaar
            // `found: null`, dezelfde regel als in attention.js.
            rows.push(...found);
            if (out?.unchecked) {
                sources[kind] = { status: 'unavailable', found: null, reason: out.unchecked };
                partial.push(kind);
            } else {
                sources[kind] = { status: 'checked', found: found.length };
            }
        } catch (e) {
            log.warn(`[WebpageUsage] ${kind} scan failed for ${webpage.id}:`, e.message);
            sources[kind] = { status: 'unavailable', found: null, reason: REASONS.SCAN_FAILED };
            partial.push(kind);
        }
    }

    return { rows, partial, sources, complete: partial.length === 0 };
}

/**
 * Versmal de rijen tot wat deze persoon verteld mag worden.
 *
 * Dezelfde regel als bij kennisbanken en vergadernotities: een rij van iemand
 * anders houdt zijn SOORT en zijn ROL — dat is wat "wat gaat er stuk" nodig
 * heeft — en verliest zijn NAAM. De route hieronder is al eigenaar-gescoopt,
 * dus in de praktijk raakt dit één rij: een Oplossing van een collega waarin
 * de eigenaar zijn pagina heeft opgeborgen. Zonder eigenaar (org-breed) is de
 * rij van niemand privé en blijft hij heel.
 */
function redactForeign(rows, userId) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
        if (!r?.ownerId) return r;
        if (String(r.ownerId) === String(userId)) return r;
        return { ...r, title: null, siteLabel: undefined, foreign: true };
    });
}

module.exports = {
    usageForWebpage,
    redactForeign,
    tableExists,
    scanSolution,
    scanAutomation,
    scanChat,
    scanAgent,
    KINDS,
    REASONS,
};
