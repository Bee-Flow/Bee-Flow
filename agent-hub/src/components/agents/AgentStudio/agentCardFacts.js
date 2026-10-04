/**
 * agentCardFacts — de FEITEN achter één kaart in het agentoverzicht, en
 * achter de chips en het zoekveld erboven (Bee Flow Builder-herontwerp,
 * sep 2026; Agents-artboard 1a, A5 deel C).
 *
 * Alles hier is puur: in gaan de rijen van `GET /agents/all` (of
 * `/agents/system`) plus de categorielijst, eruit komen getallen en
 * toestanden — geen zinnen, geen kleuren. De zinnen staan in `AgentCard.jsx`
 * en `AgentOverview.jsx`, want daar staan ook de letterlijke `t()`-sleutels
 * die de i18n-guard leest.
 *
 * ── DE DRIE PILLEN KOMEN UIT `config`, EN DAT MAG ───────────────────
 * `getAllAgents` (server/stores/agent/agentCrud.js) draait elke rij door
 * `parseConfig`, dus `config` staat als GEPARSEERD OBJECT in de lijst — geen
 * extra serverronde nodig voor "n kennis / n skills / n tools". Twee dingen
 * die daarbij horen en die de kaart niet mag verzwijgen:
 *
 *   1. Het is de CONCEPT-config. Voor een agent met `published_version > 0`
 *      serveert de runtime `published_config`, en die blob verlaat de store
 *      nooit (`_stripPublishedBlobs`). De pillen tellen dus wat er in de
 *      editor staat, niet wat er live draait — precies zoals de kop "v8"
 *      naast de statuspil de opgeslagen versie noemt.
 *   2. De tools-pil telt wat de CONFIG gunt, niet wat DEZE gebruiker in zijn
 *      catalogus heeft. De editor meet apps tegen `filterAvailableIntegrations`
 *      en toont daar bewust niets zolang `integrationStatus === null`
 *      (BuilderSplit.jsx). Die beschikbaarheid zit niet in de lijstrespons, en
 *      hem hier verzinnen zou een gemeten getal suggereren. Wat de kaart wél
 *      weet is een feit over de AGENT: hoeveel apps, automatiseringen en tabellen zijn
 *      hem gegund.
 *   3. …en dat getal is voor de meeste agents een ONDERGRENS, niet een totaal.
 *      `core/integrations/integrationTools.js` cureert de automatiseringen alleen als
 *      `config.tools` de sleutel `automations` DRAAGT; ontbreekt die, dan krijgt
 *      de agent élke agent-callable automatisering van wie er praat, plus elke in de
 *      chat gepubliceerde Step. Nul automatiseringen tellen voor zo'n agent is het
 *      omgekeerde van de waarheid, en het is precies de val die
 *      `canUse/toolGrants.js` bij naam documenteert. Vandaar `toolsAtLeast`:
 *      het getal blijft wat de config NOEMT, en de kaart zegt erbij dat er
 *      meer bij kunnen komen.
 *
 * ── LEEG IS NIET ONLEESBAAR ─────────────────────────────────────────
 * `config` kan ontbreken of onleesbaar zijn (een rij uit een andere bron, een
 * kolom die niet parseerde). Dan is het antwoord `null` — niet 0. Een 0 is de
 * bewering "deze agent heeft geen kennis", en die zet de kaart als een
 * gestippelde waarschuwingsrij op het scherm; die mag nooit op een lezing
 * staan die niet gelukt is.
 *
 * ── ONBEKEND VERSMALT ───────────────────────────────────────────────
 * `can_edit` is de serverzijde van BFSF-271 en `/agents/all` zet hem altijd.
 * `/agents/system` doet dat NIET. `can_edit === false` als enige test is dus
 * fail-open: een rij zonder het veld hield de prullenbak. Hier zijn het drie
 * toestanden, en alleen een expliciete `true` geeft een bewerk-affordance.
 */

import { datatableGrantsOf } from '../AgentWizard/canUse/canUseFacts';
import { automationGrantsOf } from '../AgentWizard/canUse/toolGrants';

/** Mag deze gebruiker de agent wijzigen? `UNKNOWN` is niet `NO` en niet `YES`. */
export const EDIT = Object.freeze({ YES: 'yes', NO: 'no', UNKNOWN: 'unknown' });

/** De categorie van een rij: geen, een gelezen naam, of een id zonder naam. */
export const CATEGORY = Object.freeze({ NONE: 'none', NAMED: 'named', UNKNOWN: 'unknown' });

/** De chip-id van "Zonder categorie" — geen echt categorie-id, dus geen botsing. */
export const NO_CATEGORY = '__no_category__';

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * De config van een lijstrij, of `null` als die er niet leesbaar in zit.
 *
 * De server levert een object (parseConfig). Een string wordt nog geprobeerd
 * — een rij die langs een andere weg binnenkwam — maar alles wat daarna geen
 * gewoon object is, is ONLEESBAAR en komt terug als `null`.
 */
export function configOf(agent) {
    if (!agent) return null;
    const raw = agent.config;
    if (isPlainObject(raw)) return raw;
    if (typeof raw === 'string' && raw) {
        try {
            const parsed = JSON.parse(raw);
            return isPlainObject(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }
    return null;
}

/** Unieke, niet-lege strings uit een lijst. Geen lijst ⇒ leeg. */
function uniqueStrings(list) {
    const seen = new Set();
    for (const v of Array.isArray(list) ? list : []) {
        if (typeof v === 'string' && v) seen.add(v);
    }
    return seen;
}

/**
 * De gekoppelde kennisbank-ids. Beide schrijfwijzen tellen mee: de config
 * draagt `knowledge_base_ids`, maar `attentionChecks.js` accepteert al jaren
 * óók `knowledgeBaseIds` en er staan rijen in het veld met die sleutel.
 */
function knowledgeIdsOf(config) {
    const raw = config.knowledge_base_ids ?? config.knowledgeBaseIds;
    return uniqueStrings(raw);
}

/**
 * De drie tellers van één kaart.
 *
 * @returns {{readable: boolean, knowledge: number|null, skills: number|null,
 *            tools: number|null, toolsAtLeast: boolean}}
 *   `readable: false` ⇒ alle drie `null`: de config kon niet gelezen worden,
 *   en dan zegt de kaart dát, in plaats van drie nullen.
 *   `tools: null` bij een leesbare config betekent hetzelfde één niveau lager:
 *   de sectie `config.tools` staat er wél maar is niet te lezen, en dan is er
 *   geen getal om te tonen. `toolsAtLeast` zegt dat het getal een ONDERGRENS is.
 */
export function countsOf(agent) {
    const config = configOf(agent);
    if (!config) return { readable: false, knowledge: null, skills: null, tools: null, toolsAtLeast: false };

    // "Sectie afwezig", "sectie leesbaar" en "sectie onleesbaar" zijn drie
    // antwoorden. De kop van dit bestand zegt "leeg is niet onleesbaar", en dat
    // gold tot nu toe alleen voor de HELE config: een `config.tools` die geen
    // object is werd hier stilletjes een gemeten nul, terwijl de server op
    // dezelfde invoer `tables: null` geeft (core/agentRuntime/agentGrounding.js).
    const rawTools = config.tools;
    const toolsMissing = rawTools === undefined || rawTools === null;
    const toolsConfig = isPlainObject(rawTools) ? rawTools : null;
    const toolsUnreadable = !toolsMissing && !toolsConfig;

    // De apps staan als vlakke lijst in `enabledIntegrations`; de automatiseringen en
    // tabellen als grants onder `config.tools`. Alle drie zijn "een ding dat
    // deze agent mag aanroepen", dus alle drie tellen mee in dezelfde pil —
    // dezelfde optelling die de tab "Kan gebruiken" op zijn teller zet.
    const apps = uniqueStrings(config.enabledIntegrations).size;
    const automations = automationGrantsOf(toolsConfig).length;
    const datatables = datatableGrantsOf(toolsConfig).grants.length;

    // De AANWEZIGHEID van de sleutel is de curatie — spiegel van
    // `_curatedAutomations` in core/integrations/integrationTools.js, dat op
    // `hasOwnProperty('automations')` kijkt en niet op de inhoud. Ontbreekt hij,
    // dan rijden de automatiseringen van de VRAGER mee en is dit getal een ondergrens.
    const curatedAutomations = !!toolsConfig
        && Object.prototype.hasOwnProperty.call(toolsConfig, 'automations');

    return {
        readable: true,
        knowledge: knowledgeIdsOf(config).size,
        skills: uniqueStrings(config.attachedSkillIds).size,
        tools: toolsUnreadable ? null : apps + automations + datatables,
        toolsAtLeast: !toolsUnreadable && !curatedAutomations,
    };
}

/**
 * LIVE of CONCEPT staat NIET in dit bestand: `publishedVersionOf` in
 * `AgentWizard/builderSplit/AgentEditorHeader.jsx` beantwoordt die vraag al
 * (en zijn test pint dat het `published_version` leest en niet
 * `is_published` — de INHOUDsvraag, niet het PUBLIEK). De kaart leest hem
 * daar; een tweede kopie hier zou de twee uit elkaar laten lopen.
 */

/**
 * Mag deze gebruiker de agent bewerken? Alleen een expliciete boolean telt;
 * een ontbrekend veld is ONBEKEND — zie de docblock bovenaan.
 */
export function editVerdict(agent) {
    const v = agent?.can_edit;
    if (v === true) return EDIT.YES;
    if (v === false) return EDIT.NO;
    return EDIT.UNKNOWN;
}

/**
 * De categorie van een rij, tegen de gelezen categorielijst.
 *
 * Een `category_id` dat we niet kunnen thuisbrengen wordt `UNKNOWN`, NOOIT
 * `NONE`: "zonder categorie" is een bewering over de agent, en de agent heeft
 * er juist wél een — we konden zijn naam alleen niet lezen.
 */
export function categoryOf(agent, categories) {
    const id = typeof agent?.category_id === 'string' && agent.category_id ? agent.category_id : null;
    if (!id) return { state: CATEGORY.NONE, id: null, name: null };
    const hit = (Array.isArray(categories) ? categories : []).find(c => c && c.id === id);
    const name = hit && typeof hit.name === 'string' && hit.name ? hit.name : null;
    return name ? { state: CATEGORY.NAMED, id, name } : { state: CATEGORY.UNKNOWN, id, name: null };
}

/**
 * De chips boven het raster: alleen categorieën die ook echt een agent
 * hebben, in de volgorde van de categorielijst, plus "Zonder categorie" als
 * er een agent zonder is.
 *
 * Een chip die naar niets filtert is een dode knop, dus lege categorieën
 * blijven weg. Agents met een onleesbare categorie (`UNKNOWN`) krijgen geen
 * eigen chip: ze horen niet in "Zonder categorie" thuis, en een chip
 * "onbekend" zou een categorie suggereren die niet bestaat. Ze blijven
 * bereikbaar zolang er geen chip actief is.
 *
 * @returns {Array<{id: string, name: string|null, count: number}>}
 *   `name: null` op de chip met id NO_CATEGORY — die schrijft de UI zelf.
 */
export function categoryChipsOf(agents, categories) {
    const rows = Array.isArray(agents) ? agents : [];
    const counts = new Map();
    let noCategory = 0;
    for (const a of rows) {
        const cat = categoryOf(a, categories);
        if (cat.state === CATEGORY.NONE) { noCategory += 1; continue; }
        if (cat.state !== CATEGORY.NAMED) continue;
        counts.set(cat.id, (counts.get(cat.id) || 0) + 1);
    }
    const chips = (Array.isArray(categories) ? categories : [])
        .filter(c => c && typeof c.id === 'string' && counts.has(c.id))
        .map(c => ({ id: c.id, name: c.name, count: counts.get(c.id) }));
    // Zonder ook maar één benoemde categorie is er niets om tegen te
    // filteren: dan is élke agent "zonder categorie" en zegt de chip niets.
    if (chips.length > 0 && noCategory > 0) {
        chips.push({ id: NO_CATEGORY, name: null, count: noCategory });
    }
    return chips;
}

/**
 * "ANTWOORDT UIT HET HOOFD" STAAT NIET IN DIT BESTAND.
 *
 * Hier stond `warnsNoKnowledge`, met een terugval op `counts.knowledge === 0`
 * zodra de server geen oordeel gaf. Dat was een TWEEDE implementatie van de
 * regel die Studio's Start-scherm (routes/studio/attentionChecks.js) uit
 * core/agentRuntime/agentGrounding.js leest, en de twee waren het al oneens:
 * een config met `knowledge_base_ids: 'kb-1'` (string) boekt de server als een
 * GAT — "kon de bedrading niet lezen", bewust géén beschuldiging — terwijl de
 * kaart er een rode "No knowledge base" bij zette.
 *
 * De waarschuwing staat nu op één plek in dit scherm: `./cardFooter.js`, dat
 * uitsluitend het woord leest dat de server stuurde (`grounding.verdict`). Een
 * rij zonder dat woord (/agents/system, een oudere payload) levert stilte op,
 * niet een eigen oordeel — onbekend versmalt. De kennis-PIL blijft gewoon zijn
 * gemeten nul tonen; dat is een telling, geen bewering over gedrag.
 */

/** Alles waarop het zoekveld matcht, als één kleingeschreven string. */
function haystackOf(agent, categories) {
    const cat = categoryOf(agent, categories);
    return [agent?.name, agent?.description, cat.name]
        .map(v => (typeof v === 'string' ? v : ''))
        .join(' ')
        .toLowerCase();
}

/**
 * Het getoonde deel van de lijst: eerst de chip, dan de zoekterm.
 *
 * @param {Array} agents        de rijen zoals de server ze gaf
 * @param {object} opts
 * @param {string} opts.query        de zoekterm ('' = alles)
 * @param {string|null} opts.categoryId  actieve chip, `NO_CATEGORY`, of null
 * @param {Array} opts.categories    de gelezen categorielijst
 */
export function filterAgents(agents, { query = '', categoryId = null, categories = [] } = {}) {
    let rows = Array.isArray(agents) ? agents : [];
    if (categoryId === NO_CATEGORY) {
        rows = rows.filter(a => categoryOf(a, categories).state === CATEGORY.NONE);
    } else if (categoryId) {
        rows = rows.filter(a => categoryOf(a, categories).id === categoryId);
    }
    const q = String(query || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(a => haystackOf(a, categories).includes(q));
}
