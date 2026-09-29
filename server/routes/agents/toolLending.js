/**
 * GET /agents/:id/tool-lending — voor welke apps kan deze agent de verbinding
 * van zijn EIGENAAR lenen?
 *
 * ── WAAROM DEZE ROUTE BESTAAT ───────────────────────────────────────
 * De Tools-kaart stelde die vraag aan zichzelf. Zij las
 * `GET /api/integrations/connections/grants?resourceType=agent&resourceId=…`,
 * en die route scopet onvoorwaardelijk op de INGELOGDE gebruiker
 * (routes/integrations/connections.js — `grantorUserId: userId`). De runtime
 * leent van `agent.owner_id`: `toolPolicy.resolveLentProviders` wordt op beide
 * plekken met de eigenaar aangeroepen (routes/agents/crud.js in
 * `applyConfigValidation`, stores/agent/agentCrud.js in `_clampRuntimeTools`).
 *
 * Zolang de bewerker de eigenaar IS, geven die twee hetzelfde antwoord. Maar
 * een agent mag ook bewerkt worden door de super-admin en door elke org-genoot
 * met `manage_agents` (canModifyAgent in ./crud.js) — en dan lopen ze uiteen,
 * in beide richtingen tegelijk:
 *
 *   de bewerker leende zelf iets uit  ⇒ het scherm bood "als jou" aan, de
 *                                       runtime weigerde het (er is niets van
 *                                       de eigenaar uitgeleend);
 *   de EIGENAAR leende iets uit       ⇒ het scherm bood het niet aan, terwijl
 *                                       de runtime het wél zou lenen — en de
 *                                       kaart tekende ondertussen "As: the
 *                                       person asking".
 *
 * De vraag hoort dus over de eigenaar te gaan, en het antwoord hoort van de
 * server te komen: de bewerker mag `agent.owner_id` niet zelf mogen invullen.
 *
 * ── WAT ER TERUGKOMT, EN WAT BEWUST NIET ────────────────────────────
 *   `apps`            de app-ids waarvoor lenen kan. Ja/nee per app, meer niet.
 *   `readable`        of dat antwoord gelezen kon worden.
 *   `runtimeCurated`  of de agent ZOALS DE RUNTIME HEM LEEST een gecureerde
 *                     grants-map heeft (`null` = niet na te gaan).
 *
 * Dat laatste veld staat hier omdat de kaart er anders naar het CONCEPT keek.
 * De leen-meldingen doen een uitspraak over wat de runtime nú doet, en de
 * runtime leest `published_config` zodra de agent ooit gepubliceerd is
 * (stores/agent/agentCrud.js `projectRuntime`), terwijl de editor de nog niet
 * opgeslagen draft in handen heeft. Eén vinkje in de kiezer maakte de draft
 * "gecureerd" en de kaart meldde meteen dat er niet meer geleend werd — terwijl
 * de gepubliceerde agent nog een uur lang gewoon leende. Precies de vorm die
 * deze route moest wegnemen: het scherm belooft het ene, de runtime doet het
 * andere. Wie het antwoord niet kan lezen (`null`) zegt niets.
 *
 * Geen label, geen connection-id, geen begunstigde, geen provider. De bewerker
 * hoeft de eigenaar niet te zijn, en dan is "welke verbinding hangt hier" een
 * blik in andermans integraties. De vertaling van providers naar apps gebeurt
 * daarom in `toolPolicy.lentAppsFor` — dezelfde kaart die `normaliseToolsConfig`
 * gebruikt om te beslissen of een opgeslagen `actAs: 'owner'` overleeft, zodat
 * de kiezer en de runtime het niet oneens kunnen worden.
 *
 * ── ONBEKEND VERSMALT ───────────────────────────────────────────────
 * `readable: false` betekent: geen leenkeuze aanbieden, en zeggen waarom. Het
 * is het antwoord voor een agent zonder eigenaar, voor een probe die stuk is
 * en voor een attributie die stuk is — nooit een stille lege lijst, want die
 * leest als "de eigenaar heeft niets uitgeleend" en dat is een bewering.
 *
 * "Lenen staat uit" is het ene geval dat WEL een gelezen nul is: er valt niets
 * te lenen, dat is een feit, en de kaart hoort er geen storingsmelding voor te
 * tonen. Zonder dat onderscheid zou elke installatie met de standaardinstelling
 * (lenen UIT) permanent "kon het niet lezen" tonen.
 *
 * ── WAAROM HET EDIT-RECHT ───────────────────────────────────────────
 * Zelfde afweging als routes/agents/usage.js: dit is een antwoord uit de
 * editor, en het gaat over de verbindingen van de eigenaar. Wie de agent niet
 * eens mag zien krijgt dezelfde 404 als `GET /:id`; wie hem wel mag gebruiken
 * maar niet bewerken krijgt de 403 van de editor.
 *
 * ── GEEN QUERY ──────────────────────────────────────────────────────
 * De route leest niets uit de query, en zegt dat hardop: de hele reden van
 * bestaan is dat de bewerker NIET mag kiezen over wiens verbindingen het
 * antwoord gaat. Een `?ownerId=` of `?userId=` die dat lijkt te doen werd
 * genegeerd en beantwoord over de echte eigenaar, met een 200: een antwoord op
 * een andere vraag dan de gestelde. Nu een 400 die de sleutel noemt.
 *
 * Run: cd server && node --test routes/agents/toolLending.test.js
 */

const express = require('express');
const agentStore = require('../../stores/agentStore');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { canReadAgent, canModifyAgent } = require('./crud');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const NoQuery = z.object({}).strict();

const router = express.Router();

/**
 * Het smalle antwoord: niets te lenen, en dat is niet gelezen.
 *
 * Bevroren omdat hij per request wordt hergebruikt — een gedeeld antwoord dat
 * één keer gevuld raakt, zou vanaf dan aan iedereen worden verteld.
 */
const UNREADABLE = Object.freeze({ apps: Object.freeze([]), readable: false });

/**
 * Heeft de agent een gecureerde grants-map ZOALS DE RUNTIME HEM LEEST?
 *
 * `getForRuntime` is dezelfde lezing die beide dispatchsites doen: de
 * gepubliceerde config als de agent gepubliceerd is, anders de levende — en
 * geklemd, want dat is ook wat er draait. `null` betekent "niet na te gaan";
 * dat is geen "niet gecureerd", en de kaart hoort er dan niets over te zeggen.
 */
async function runtimeCuratedOf(agentId) {
    try {
        const runtime = await agentStore.getForRuntime(agentId);
        if (!runtime) return null;
        const policy = require('../../core/agentRuntime/toolPolicy');
        return policy.hasCuratedGrants(policy.toolsConfigOf(runtime.config)) === true;
    } catch (e) {
        log.warn('[agents/tool-lending] runtime config unreadable:', e.message);
        return null;
    }
}

/**
 * De apps waarvoor de EIGENAAR van deze agent een verbinding heeft uitgeleend.
 *
 * Elke tak die niet tot een gelezen ja of nee komt, komt uit op `UNREADABLE`.
 * De enige lege lijst die WEL gelezen is, is de uitgeschakelde leenfunctie.
 */
async function lendableAppsFor(agent) {
    let isLendingEnabled = null;
    try {
        ({ isLendingEnabled } = require('../../core/integrations/connectionResolution'));
    } catch (e) {
        log.warn('[agents/tool-lending] connection resolution unavailable:', e.message);
        return UNREADABLE;
    }
    let enabled = false;
    try {
        enabled = isLendingEnabled() === true;
    } catch (e) {
        // Een vlag die niemand kan lezen is geen "aan", maar ook geen gelezen
        // "uit": de kaart hoort te weten dat dit antwoord niet klopt.
        log.warn('[agents/tool-lending] lending flag unreadable:', e.message);
        return UNREADABLE;
    }
    // Lenen staat uit: een gelezen nul. Geen databasewerk, geen melding.
    if (!enabled) return { apps: [], readable: true };

    // Geen eigenaar = niet te zeggen wiens verbinding dit zou zijn. Dat is
    // NIET "ja", en het is ook geen aanleiding om dan maar op de bewerker te
    // filteren — precies de verwisseling die deze route dicht.
    const ownerId = agent && agent.owner_id;
    if (!ownerId) return UNREADABLE;

    const policy = require('../../core/agentRuntime/toolPolicy');
    const lentProviders = await policy.resolveLentProviders({ agentId: agent.id, ownerId });
    // `null` = lenen stond uit (hierboven al afgevangen) of de probe faalde.
    if (!(lentProviders instanceof Set)) return UNREADABLE;

    // `null` = de app→provider-kaart is degraded; elke uitkomst zou een gok
    // zijn. Zie toolPolicy.lentAppsFor.
    const apps = policy.lentAppsFor(lentProviders);
    if (!Array.isArray(apps)) return UNREADABLE;
    return { apps, readable: true };
}

router.get('/:id/tool-lending', validate({ query: NoQuery }), async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        // Zelfde 404 als GET /:id voor wie de agent niet mag zien — "je mag
        // niet" en "hij bestaat niet" horen niet uit elkaar te houden zijn.
        if (!(await canReadAgent(agent, userId, req))) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        if (!(await canModifyAgent(agent, userId, req))) {
            return res.status(403).json({
                error: 'You do not have permission to edit this agent.',
                code: 'agent_not_editable',
            });
        }

        const [lending, runtimeCurated] = await Promise.all([
            lendableAppsFor(agent),
            runtimeCuratedOf(agent.id),
        ]);
        res.json({ ...lending, runtimeCurated });
    } catch (e) {
        log.error('[agents/tool-lending] failed:', e.message);
        // 500, niet een leeg antwoord met `readable: true`: de kaart leest een
        // mislukte lezing als "niet na te gaan" en biedt dan geen leenkeuze.
        res.status(500).json({ error: 'Could not check lent connections' });
    }
});

module.exports = router;
