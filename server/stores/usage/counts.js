// @typecheck
/**
 * Per-id counts read from ai_usage_log: test chats per agent and App Studio
 * action runs per app, each under its own literal source name.
 */

const { getAll } = require('../../db');
const { initDB } = require('./schema');

// De bron waaronder een TESTCHAT (A4) zijn verbruik wegschrijft. Letterlijk
// herhaald in plaats van geïmporteerd, zodat een store niets uit de runtime
// hoeft te trekken; `usageStore.testChats.test.js` pint de twee op elkaar,
// zodat hernoemen aan één kant rood wordt in plaats van stil de telling op
// nul te zetten.
const TEST_CHAT_SOURCE = 'agent_test_chat';

/**
 * Hoeveel TESTGESPREKKEN heeft elke agent gehad? (A4)
 *
 * Een testgesprek schrijft met opzet geen rij in `agent_conversations` — dat
 * is precies wat het uit de historie, uit de kaartvoet (A5) en uit elke
 * export houdt. Maar het KOST wel iets, dus het staat wél in `ai_usage_log`,
 * onder zijn eigen bron. Eén efemere conversatie krijgt één id, dus
 * `COUNT(DISTINCT conversation_id)` is precies "n testgesprekken" — geen
 * beurten en geen modelaanroepen, die zijn er meer per gesprek.
 *
 * Die "één id" is een eigenschap van `testChat.ephemeralConversationId`, niet
 * van deze query: die hasht de sessiesleutel van de client samen met de
 * gebruiker en de agent, zodat alle beurten van één testgesprek dezelfde id
 * dragen. Draait er ooit een testbeurt ZONDER sessiesleutel, dan krijgt hij
 * een verse id en telt hij als een eigen gesprek — te hoog, nooit te laag.
 *
 * Rijen zonder `conversation_id` tellen niet mee: die kunnen niet aan een
 * gesprek worden toegewezen, en één ervan meetellen als "een gesprek" zou de
 * telling naar boven afronden op een aanname.
 *
 * @param {string[]} agentIds
 * @param {object} [opts]
 * @param {object} [opts.db] injectieplek voor de tests
 * @returns {Promise<Map<string, number>>} één entry per gevraagde id; nul is
 *   hier een vastgesteld feit, geen ontbrekend antwoord.
 */
async function getTestChatCounts(agentIds, { db = null } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(DISTINCT conversation_id)::int AS test_chats
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND conversation_id IS NOT NULL
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, TEST_CHAT_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, TEST_CHAT_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.test_chats) || 0);
    }
    return out;
}

// De bron waaronder een ACTIERUN van een App Studio-app zijn regel wegschrijft
// (routes/studioAppsRun.js, zowel /run als /step). Letterlijk herhaald in
// plaats van geimporteerd — zelfde afweging als TEST_CHAT_SOURCE bovenaan dit
// bestand: een store hoort niets uit de runtime te trekken, en
// `usageStore.studioAppRuns.test.js` pint de twee op elkaar zodat hernoemen
// aan een kant rood wordt in plaats van de telling stil op nul te zetten.
const STUDIO_APP_ACTION_SOURCE = 'studio_app_action';

// Vensters voor getStudioAppRunCounts. GESLOTEN lijst, want de waarde is een
// SQL-fragment: de sleutel mag uit een query-parameter komen, de waarde nooit.
// 'month' is de kalendermaand (vanaf de 1e), niet de laatste 30 dagen, omdat
// het label dat dit getal draagt "deze maand" zegt.
const RUN_COUNT_WINDOWS = {
    month: "date_trunc('month', NOW())",
};

/**
 * Hoeveel ACTIERUNS heeft elke App Studio-app dit venster gehad? (APPS-08)
 *
 * Wat dit telt is precies een ding: runs van een app-actie via de
 * run_automation-brug — `routes/studioAppsRun.js` schrijft daar per run een
 * `ai_usage_log`-rij voor met `agent_type='studio_app'`, `agent_id = app.id`
 * en deze bron. Het is GEEN openingenteller: een app die alleen records
 * aanmaakt langs een ander pad staat hier op 0 terwijl hij dagelijks draait.
 * Wie het getal toont moet dus zeggen WAT het telt ("N acties deze maand") en
 * nooit "N x", want dat leest als "N keer geopend" — een ander getal, dat deze
 * bron niet heeft.
 *
 * De valkuil zit in user_id. Elke rij staat op de EIGENAAR van de app (de run
 * draait acts-as-owner, ook als een collega op de knop drukt), dus filteren op
 * de kijker levert nul voor iedereen behalve de bouwer. Deze query filtert
 * daarom nooit op user_id. De org-afbakening zit in de ID-LIJST die de
 * aanroeper meegeeft: de route vult die met `getAccessibleStudioApps`,
 * hetzelfde zichtbaarheidspredicaat als de directory zelf. Er bovenop nog eens
 * op organization_id filteren zou juist de eigen ongepubliceerde app van de
 * eigenaar op nul zetten — diens rijen dragen `organization_id` NULL.
 *
 * @param {string[]} appIds
 * @param {object} [opts]
 * @param {string} [opts.window='month'] sleutel uit RUN_COUNT_WINDOWS
 * @param {object} [opts.db] injectieplek voor de tests
 * @returns {Promise<Map<string, number>>} een entry per gevraagde id; nul is
 *   hier een vastgesteld feit, geen ontbrekend antwoord.
 */
async function getStudioAppRunCounts(appIds, { window = 'month', db = null } = {}) {
    const since = RUN_COUNT_WINDOWS[window];
    if (!since) throw new Error(`getStudioAppRunCounts: unknown window '${window}'`);
    const ids = [...new Set((Array.isArray(appIds) ? appIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(*)::int AS runs
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND timestamp >= ${since}
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, STUDIO_APP_ACTION_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, STUDIO_APP_ACTION_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.runs) || 0);
    }
    return out;
}

module.exports = { TEST_CHAT_SOURCE, STUDIO_APP_ACTION_SOURCE, RUN_COUNT_WINDOWS, getTestChatCounts, getStudioAppRunCounts };
