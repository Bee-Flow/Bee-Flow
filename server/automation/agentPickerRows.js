/**
 * De agent-KIEZER van de AI-stap: welke agents staan er in de lijst, en wat
 * staat erbij als er eentje niet gekozen kan worden? (R2, deel C)
 *
 * ── WAAROM DIT NIET automation/agentCatalog.js IS ───────────────────
 * Die module beantwoordt de VALIDATIE-vraag: mag deze routine dit ene id
 * gebruiken, ja of nee. Hij zegt met opzet nooit waarom niet — een id komt daar
 * uit een definitie die iemand ook met de hand kan hebben getypt, en een
 * uitgesplitst antwoord ("bestaat niet" vs. "andere organisatie") maakt de
 * routine-editor tot een bestaans-orakel voor elke andere workspace op deze
 * installatie.
 *
 * Hier ligt dat anders, en precies daarom is het een aparte module. Deze lijst
 * wordt niet uit een definitie opgebouwd maar uit wat de vrager AL MAG ZIEN:
 * zijn eigen agents plus de gepubliceerde agents die zijn organisatie en zijn
 * groepen hem tonen. Over die rijen weet hij alles al. "Deze staat er wel maar
 * is nog niet gepubliceerd" vertelt hem dus niets nieuws — en wél weglaten is
 * het ergste van alles: dan zoekt iemand zijn agent, ziet hem niet, en gaat op
 * zoek naar een bug in plaats van op de publiceerknop te drukken.
 *
 * De grens is dus: de REDEN reist alleen mee voor een rij die de aanroeper zelf
 * al zichtbaar heeft gemaakt. Nooit voor een id dat iemand invulde.
 *
 * ── ÉÉN OORDEEL, EN DE REDEN BESLIST NIET ───────────────────────────
 * `canUse` komt uit `mayRoutineUseAgent` — dezelfde functie die de save-check
 * gebruikt en die `aiStepAgent._mayUseAgent` bij elke run naast zich heeft
 * staan. De reden hieronder is UITLEG en geen tweede oordeel: hij wordt pas
 * berekend als het oordeel al "nee" is, en kan dat "nee" dus niet omzetten in
 * een "ja". Zou `explainRefusal` een geval missen, dan is de uitkomst een
 * vagere zin ('unavailable') en nooit een agent die alsnog kiesbaar wordt.
 */

'use strict';

const { mayRoutineUseAgent, servesPublishedConfig } = require('./agentCatalog');

/**
 * De redenen die de kiezer toont. Alleen deze vier; een geval dat er niet in
 * past wordt `unavailable` — vager, nooit ruimer.
 *
 *   not_published  de agent staat nog op concept — de publiceer-schakelaar
 *                  uit, of aan zonder dat er ooit een VERSIE is gepubliceerd
 *                  (dan draait hij nog op zijn live klad; `servesPublishedConfig`)
 *   other_org      hij hoort bij een andere organisatie dan de vrager
 *   not_shared     gepubliceerd, zelfde organisatie, maar met groepen gedeeld
 *                  waar de vrager niet in zit
 *   unavailable    het oordeel was nee en geen van de drie past
 */
const AGENT_PICKER_REASONS = Object.freeze(['not_published', 'other_org', 'not_shared', 'unavailable']);

/** Agents die geen keuze ZIJN: het product levert ze, niemand publiceert ze. */
const SYSTEM_OWNER_IDS = Object.freeze(['system', 'swarm']);

function _isSystemAgent(agent) {
    return !!agent && SYSTEM_OWNER_IDS.includes(agent.owner_id);
}

/**
 * Waarom mag deze vrager deze agent niet inzetten?
 *
 * Wordt UITSLUITEND aangeroepen als `mayRoutineUseAgent` al nee heeft gezegd —
 * zie de kop. De volgorde is die van `mayRoutineUseAgent` zelf, zodat de zin
 * de eerste hindernis noemt en niet een latere.
 */
function explainRefusal(agent, { userId: _userId = null, orgId = null, groups = [] } = {}) {
    if (!agent) return 'unavailable';
    // Beide publicatie-hindernissen geven dezelfde zin, want de handeling is
    // dezelfde: publiceren. De deel-schakelaar aanzetten zonder ooit een versie
    // te publiceren laat de agent op zijn LIVE concept draaien, en daar mag een
    // routine van een ander niet op bouwen — zie `servesPublishedConfig`.
    if (!agent.is_published || !servesPublishedConfig(agent)) return 'not_published';
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return 'other_org';
    } else if (agent.organization_id) {
        return 'other_org';
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    const mine = Array.isArray(groups) ? groups : [];
    if (sharedGroups.length > 0 && !sharedGroups.some((g) => mine.includes(g))) return 'not_shared';
    // Het oordeel was nee en geen van de drie past — dan is de eerlijke zin de
    // vage. Nooit terugvallen op "dan mag het zeker wel".
    return 'unavailable';
}

/**
 * De rijen voor de kiezer.
 *
 * @param {Array} rows   agent-rijen zoals `getAgents` en
 *   `getPublishedAgentsForUser` ze geven (parseConfig-vorm: `shared_groups` is
 *   al een array). De aanroeper plakt de twee lijsten aan elkaar; hier wordt
 *   ontdubbeld op id, waarbij de EERSTE wint — de eigen-agents-lijst hoort dus
 *   vooraan te staan, want die draagt de conceptstand van een rij die in beide
 *   lijsten voorkomt.
 * @param {object} viewer  `{ userId, orgId, groups }` van de ROUTINE-EIGENAAR
 * @returns {Array<{id,name,description,scope,canUse,reason}>} op naam gesorteerd
 */
function agentPickerRows(rows, viewer = {}) {
    const seen = new Set();
    const out = [];
    for (const agent of Array.isArray(rows) ? rows : []) {
        if (!agent || typeof agent !== 'object') continue;
        const id = typeof agent.id === 'string' ? agent.id : null;
        if (!id || seen.has(id)) continue;
        // Systeemagents hebben geen publiceerknop en zijn geen keuze; ze zouden
        // hier als "nog niet gepubliceerd" verschijnen en dat is een raad die
        // niemand kan opvolgen.
        if (_isSystemAgent(agent)) continue;
        seen.add(id);
        const canUse = mayRoutineUseAgent(agent, viewer) === true;
        out.push({
            id,
            name: typeof agent.name === 'string' && agent.name ? agent.name : id,
            description: typeof agent.description === 'string' ? agent.description : null,
            // Wie hem verder nog kan zien — dezelfde woorden als de
            // kennisbank-kiezer hierboven in dezelfde catalogus.
            scope: agent.organization_id ? 'org' : 'personal',
            canUse,
            reason: canUse ? null : explainRefusal(agent, viewer),
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

module.exports = { AGENT_PICKER_REASONS, agentPickerRows, explainRefusal };
