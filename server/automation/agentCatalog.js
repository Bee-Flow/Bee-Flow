/**
 * "Deze routine noemt een agent — mag die hier draaien?" — de SAVE-kant van R2.
 *
 * ── WAAROM DIT NIET IN validate/stepRules.js ZIT ────────────────────
 * De regel staat daar wél; het ANTWOORD kan daar niet vandaan komen. Bestaat
 * de agent, zit hij in dezelfde organisatie, is hij gepubliceerd: dat zijn drie
 * databasevragen, en `validate/` is bewust de pure pass (hij draait in de
 * builder, bij import, en in tests zonder database erachter). Dus levert deze
 * module de catalogus — een Set met de ids die deze routine mág gebruiken — en
 * geeft de route die door als `availableAgents`. Precies de constructie die
 * `availableTools` al gebruikt, en dezelfde splitsing als
 * `core/kb/automationKbCheck.js` voor kennisbanken.
 *
 * ── ÉÉN ANTWOORD VOOR ELKE MANIER VAN NIET-MOGEN ────────────────────
 * Deze module zegt alleen WELKE ids mogen. Niet welke bestaan, niet waarom een
 * id ontbreekt. Dat is geen luiheid maar het punt: een verwijderde agent, een
 * agent van een andere organisatie, een agent die niet met de eigenaar gedeeld
 * is en een agent die nooit gepubliceerd is vallen alle vier op dezelfde manier
 * uit de Set, en `stepRules.js` maakt er één melding van. Zou het onderscheid
 * hier of daar overleven, dan is de routine-editor een bestaans-orakel voor
 * elke andere workspace op deze installatie: typ een id, lees aan de
 * foutmelding af of hij ergens bestaat.
 *
 * ── DEZELFDE VRAAG ALS DE RUN, MAAR EEN DAG EERDER ──────────────────
 * `mayRoutineUseAgent` hieronder stelt exact de vraag die
 * `core/automationRunner/aiStepAgent.js` (`_mayUseAgent`) bij ELKE run opnieuw
 * stelt. Dat die twee gelijk blijven is niet vanzelfsprekend, dus het is een
 * test (automation/validate.agentStep.test.js) en geen belofte: de test draait
 * beide over dezelfde tabel gevallen en vergelijkt de uitkomst.
 *
 * De run is de echte poort. Deze pass draait bij opslaan en bij activeren; de
 * agent kan dagen later worden verwijderd, gedepubliceerd of uit de deling
 * gehaald, en geen enkele validatie ziet dat aankomen. `resolveStepAgent`
 * GOOIT dan, zodat de stap faalt in plaats van stilzwijgend zonder agent door
 * te lopen. Daarom mag deze pass fail-open zijn — en daarom alleen in zijn
 * geheel: een id dat we niet konden nagaan wordt nooit als "mag niet"
 * gerapporteerd (dat zou een verkeerd antwoord zijn op een storing), en ook
 * nooit stilletjes goedgekeurd. Dan is er gewoon geen catalogus.
 */
const log = require('../telemetry/log');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Loop de stappen af, inclusief lus-bodies en parallelle takken — dezelfde
 * nesting die `validate/`, `portability.js` en `automationKbCheck.js` aflopen.
 * Overgeschreven in plaats van geïmporteerd, om de reden die
 * `automationKbCheck.js` over zichzelf geeft: dit moet vanuit een route te
 * requiren zijn zonder de hele automation-feature mee te trekken.
 */
function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

/**
 * Elke agent-id die deze definitie noemt — in de hoofdgraaf en in elke inline
 * laag. Alleen de ids; welke stap ze noemt weet `stepRules.js` al.
 */
function collectAgentIds(definition) {
    const ids = new Set();
    const take = (step) => {
        if (step.type !== 'ai_step') return;
        const id = typeof step.agentId === 'string' ? step.agentId.trim() : '';
        if (id) ids.add(id);
    };
    walkSteps(definition?.steps, take);
    const layers = isObject(definition?.layers) ? definition.layers : {};
    for (const layer of Object.values(layers)) {
        if (isObject(layer)) walkSteps(layer.steps, take);
    }
    return [...ids];
}

/**
 * Mag deze routine deze agent inzetten?
 *
 * De vier regels, in de volgorde waarin ze beslissen:
 *
 *   eigenaar                → ja, ook ongepubliceerd. Je eigen agent in je
 *                             eigen routine is geen deel-vraag.
 *   niet gepubliceerd       → nee. Publiceren is wat een agent van een concept
 *                             tot iets maakt waar een ander op kan bouwen — en
 *                             dat geldt voor de VERSIE net zo goed als voor de
 *                             deel-schakelaar (`servesPublishedConfig`).
 *   andere organisatie      → nee, en een org-agent tegenover iemand zonder
 *                             organisatie net zo min.
 *   gedeeld met groepen     → alleen als de eigenaar in één van die groepen zit.
 *
 * Een groepenlijst die niet te lezen was is leeg, en leeg betekent hier "in geen
 * enkele groep": onbekend versmalt, ook hier.
 *
 * `owner_id`-gelijkheid alléén zou te streng zijn (een routine mag een gedeelde
 * org-agent inzetten) en `organization_id`-gelijkheid alléén te ruim (de
 * ongedeelde agent van een collega hoort niet in de routine van een ander).
 *
 * @param {object} agent   een rij zoals `agentStore.getForRuntime` hem geeft
 * @param {object} p       { userId, orgId, groups } van de ROUTINE-EIGENAAR
 */
/**
 * Draait deze rij op zijn GEPUBLICEERDE config?
 *
 * ── TWEE SCHAKELAARS, ÉÉN BEWERING ──────────────────────────────────
 * `is_published` is de DEEL-schakelaar: hij zet de agent in de bibliotheek
 * (`setAgentPublished`, stores/agent/agentCrud.js). WELKE config draait wordt
 * elders beslist — `isSplitActive`: `published_version > 0` én een
 * `published_config` die er is. Die twee zijn onafhankelijk: publiceren naar de
 * bibliotheek raakt `published_version` niet aan, `publishAgentVersion` is een
 * aparte handeling, en de backfill draait bewust niet bij boot. `is_published
 * = TRUE` met `published_version = 0` is dus een gewone toestand, en dan
 * serveert `getForRuntime` de LIVE conceptconfig (`runtimeSource: 'live'`).
 *
 * Voor de EIGENAAR is dat prima — die kent zijn eigen klad. Voor een ander
 * niet: dan draait een onbewaakte routine op de nog-in-bewerking `config.tools`
 * van een collega (precies de per-actie-grants waarop de hele aftrek in
 * `core/automationRunner/aiStepAgent.js` rust), zijn concept-kennisbanken en
 * zijn conceptprompt — en verandert élke autosave in de agent-editor per direct
 * wat er vannacht in andermans account gebeurt, zonder versie en zonder review.
 * Publiceren is wat een agent tot iets maakt waar een ander op kan bouwen; dan
 * moet het ook de gepubliceerde config zijn die draait.
 *
 * `runtimeSource` is het antwoord dat `getForRuntime` en
 * `getPublishedAgentsForUser` zelf meesturen. Een rij uit `getAgents` draagt
 * dat veld niet maar wel `published_version`; die telt dan. Ontbreken ze
 * allebei, dan is er geen bewijs van een publicatie — en onbekend versmalt.
 */
function servesPublishedConfig(agent) {
    if (!agent) return false;
    if (typeof agent.runtimeSource === 'string') return agent.runtimeSource === 'published';
    return Number(agent.published_version) > 0;
}

function mayRoutineUseAgent(agent, { userId = null, orgId = null, groups = [] } = {}) {
    if (!agent) return false;
    if (agent.owner_id && userId && agent.owner_id === userId) return true;
    if (!agent.is_published) return false;
    // Gedeeld is nog niet gepubliceerd — zie `servesPublishedConfig`.
    if (!servesPublishedConfig(agent)) return false;
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return false;
    } else if (agent.organization_id) {
        return false;
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    if (sharedGroups.length === 0) return true;
    const mine = Array.isArray(groups) ? groups : [];
    return sharedGroups.some((g) => mine.includes(g));
}

/**
 * De catalogus voor één definitie: de agent-ids die deze routine mag gebruiken.
 *
 * Alleen de ids die de definitie NOEMT worden opgezocht — niet de hele
 * bibliotheek. Een routine noemt er hooguit een handvol, en de vraag "welke
 * agents bestaan er nog meer" hoeft nergens beantwoord te worden om deze te
 * beantwoorden.
 *
 * @returns {Promise<Set<string>|null>} `null` = niet na te gaan (geen
 *   catalogus, dus geen regel; de run controleert opnieuw). Nooit een
 *   halve Set: één mislukte lookup zet de hele pass uit.
 */
async function agentCatalogFor(definition, { userId = null, orgId = null, groups = [], deps = {} } = {}) {
    const ids = collectAgentIds(definition);
    // Geen agent-stap ⇒ een lege catalogus, geen `null`: er valt niets na te
    // gaan, en `null` zou "de check kon niet draaien" betekenen.
    if (!ids.length) return new Set();
    try {
        const store = deps.agentStore || require('../stores/agentStore');
        const usable = new Set();
        for (const id of ids) {
            const agent = await store.getForRuntime(id);
            if (mayRoutineUseAgent(agent, { userId, orgId, groups })) usable.add(id);
        }
        return usable;
    } catch (e) {
        // Zie de kop: een storing mag geen weigering worden. Zonder catalogus
        // slaat `stepRules.js` de identiteitsregel over en blijft de run-check
        // de poort.
        log.warn('[automation/agentCatalog] agent lookup unavailable — saving without the agent check:', e.message);
        return null;
    }
}

/**
 * De catalogus voor één definitie, met de IDENTITEIT die de run gebruikt.
 *
 * ── WAAROM DIT NAAST agentCatalogFor STAAT ──────────────────────────
 * `agentCatalogFor` krijgt `{userId, orgId, groups}` aangereikt, en dat is
 * precies het stuk dat elke aanroeper anders deed: de activatie-route pakte de
 * STEMPEL op de routine-rij (`a.organizationId`) met de sessie als terugval, de
 * run leest het LIDMAATSCHAP van de eigenaar vers uit `users`
 * (`ctx.userHomeOrgId`, execution.js), en de kiezer weer iets anders. Drie
 * antwoorden op één vraag betekent dat een van de drie een routine goedkeurt
 * die de run weigert — groen op het scherm, elke nacht `agent_unavailable`.
 *
 * Dus staat de vraag hier één keer, en stellen alle save- en activatiepaden hem
 * zo: de EIGENAAR van de routine, zijn huidige organisatie, zijn huidige
 * groepen. Een beheerder die iemand naar een andere organisatie verplaatst
 * verandert daarmee wat zijn routines mogen — dat is het antwoord dat klopt,
 * want het is ook wat de run doet.
 *
 * Fail-open in zijn GEHEEL, net als `agentCatalogFor`: een identiteitslezing
 * die niet lukt levert `null` (geen catalogus, dus geen regel), nooit een halve
 * Set waarin een agent ten onrechte als "mag niet" wordt gerapporteerd.
 *
 * @param {object} definition  de routine-definitie
 * @param {string} ownerId     de EIGENAAR van de routine (niet de drukker)
 * @returns {Promise<Set<string>|null>}
 */
async function agentCatalogForOwner(definition, ownerId, { deps = {} } = {}) {
    // Geen agent-stap ⇒ geen enkele lookup. Een lege Set, niet `null`: er valt
    // niets na te gaan, en `null` zou "de check kon niet draaien" betekenen.
    if (!collectAgentIds(definition).length) return new Set();
    if (!ownerId) return null;
    let orgId = null;
    let groups = [];
    try {
        const userStore = deps.userStore || require('../stores/userStore');
        const { resolveUserGroups } = deps.audience || require('../auth/audience');
        const [owner, gs] = await Promise.all([userStore.getUser(ownerId), resolveUserGroups(ownerId)]);
        orgId = (owner && owner.organizationId) || null;
        groups = Array.isArray(gs) ? gs : [];
    } catch (e) {
        log.warn('[automation/agentCatalog] owner identity unavailable — saving without the agent check:', e.message);
        return null;
    }
    return agentCatalogFor(definition, { userId: ownerId, orgId, groups, deps });
}

module.exports = { collectAgentIds, mayRoutineUseAgent, agentCatalogFor, agentCatalogForOwner, servesPublishedConfig };
