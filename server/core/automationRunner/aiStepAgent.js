/**
 * Een AI-stap die door een AGENT wordt gedraaid (R2, deel B).
 *
 * `ai_step.agentId` zet een agent achter één stap van een automation. Wat die
 * agent daar meebrengt — zijn rol, zijn kennisbanken, zijn skills, zijn tools
 * — wordt HIER samengesteld; `execAi.js` roept dit aan en bouwt de stap met
 * het antwoord.
 *
 * ── WAT WORDT GELADEN: DE GEPUBLICEERDE CONFIG ──────────────────────
 * `agentStore.getForRuntime` levert de gepubliceerde config en de bij publicatie
 * gerenderde `system_prompt` (`stores/agent/agentCrud.js: projectRuntime`), of —
 * zolang een agent nooit gepubliceerd is — de live concept-versie, met
 * `runtimeSource` erbij zodat een run achteraf te lezen is. De persona wordt
 * bewust NIET gerenderd: `parseConfig` strippt hem, en de concept-persona op de
 * gepubliceerde prompt plakken zou een bewering zijn die niemand controleerde
 * (zie `core/agentRuntime/personaPrompt.js`).
 *
 * Die live-terugval geldt alleen voor de EIGENAAR. De agent van een ander mag
 * hier uitsluitend draaien als hij ook echt een gepubliceerde VERSIE serveert —
 * `core/automationModel/agentPublication.js: servesPublishedConfig`. `is_published` is de
 * deel-schakelaar, `published_version > 0` beslist welke config draait, en die
 * twee staan los van elkaar; zonder deze regel draait de onbewaakte automatisering van
 * de één op het levende klad van de ander.
 *
 * ── WIE IS DE VRAGER: DE AUTOMATION-EIGENAAR ───────────────────────────
 * `ctx.userId`, altijd. De agent kan van iemand anders zijn; zijn kennisbanken,
 * zijn automatiseringen en zijn tools worden daarom gemeten aan wat de AUTOMATION-EIGENAAR
 * zelf mag. De agent kan alleen versmallen, nooit verbreden — dat is precies de
 * doorsnede die `getIntegrationTools` en `filterKbIdsForUser` al maken.
 *
 * ── DE TOOLS: PER-ACTIE-GRANTS MINUS ALLES WAT `ask` IS ─────────────
 * Een automatisering draait ONBEWAAKT. Er is niemand om een bevestiging aan te vragen,
 * dus een tool die een mens zou moeten goedkeuren mag hier niet automatisch
 * lopen. De aftrek gebeurt met `buildToolPolicy` — dezelfde functie waarmee de
 * chat `ask` bepaalt (`core/agentRuntime/toolPolicy.js`, gebruikt door
 * `toolStackAssembly`/`chatStream`) — en niet met een tweede lijst hier: een
 * eigen lijst is een tweede plek die uit de rechtenlaag kan lopen, en de plek
 * die drift is altijd de plek waar niemand naar kijkt.
 *
 * Drie dingen die daaruit volgen, en die geen van drieën vanzelf goed gaan:
 *
 *   0. DE GRANTS WORDEN TWEE KEER GESTELD. `getIntegrationTools` past ze toe bij
 *      het bouwen van de catalogus, maar loopt bij een onbereikbare policy-module
 *      door ZONDER ze; hier wordt `isToolAllowed` daarom nog een keer over de
 *      uitkomst gehaald. Twee keer versmallen kost niets en sluit de tak waarin
 *      een `require` die gooide een volledige toolbelt oplevert.
 *   1. NIET `droppedForUnattended`. Die lijst hangt aan `hasStoredGrants`
 *      (`toolPolicy.js`: `gated = confirm === 'ask' && (hasStoredGrants ||
 *      hasOverride)`), bewust, zodat een bestaande mailende automatisering niet stilvalt.
 *      Op DIT oppervlak bestaat die geschiedenis niet: een agent die niemand
 *      cureerde zou dan élke verzendende tool meekrijgen, ongevraagd en
 *      onbevestigd. Daarom is de bewaarregel `confirmByTool === 'direct'` —
 *      het POLICY-oordeel, niet de runtime-vraag.
 *   2. EEN DEGRADED REGISTRY GEEFT GEEN REGISTRY-TOOLS. Met de attributie stuk
 *      lijkt elke naam onbekend, en "ik kon niet nagaan welke app dit is" is
 *      geen "er is geen app". Voor een gecureerde agent weigert `isToolAllowed`
 *      die namen al; voor een agent die niemand cureerde zou het antwoord
 *      "dan maar alles" zijn. Onbekend versmalt: alleen tools die hun eigen
 *      identiteit dragen (een automatisering, een MCP-server, een custom integratie)
 *      overleven, want die worden niet door het registry geattribueerd.
 *   3. EEN POLICY DIE NIET GEBOUWD KAN WORDEN IS GEEN GRANT. Gooit
 *      `buildToolPolicy`, dan krijgt de stap geen tools — hij draait door als
 *      een gewone tekststap.
 *
 * Wat een automatisering tóch onbewaakt moet kunnen doen, hoort achter een expliciete
 * goedkeuringsstap (`approval`) in de automatisering zelf; de weggehouden namen komen
 * daarom mee terug (`withheld`) in plaats van stil te verdwijnen.
 *
 * ── STARTAUTOMATIONS ────────────────────────────────────────────────
 * `getIntegrationTools` krijgt de `agentConfig` mee en doet de doorsnede voor
 * AGENT-AANROEPBARE automatiseringen al (automatiseringen van de VRAGER ∩ ids die de
 * agent-eigenaar heeft gegrant — `core/integrations/integrationTools.js`).
 * Staat de permissie uit, dan worden die tools NA de assemblage weggehaald op
 * hun eigen marker; de `agentConfig` weglaten zou ook de per-actie-grants op
 * alle andere tools uitzetten, en dat is een verbreding.
 *
 * De HERBRUIKBARE STEPS (`__step`) gaan daar níét doorheen: die worden in
 * `getIntegrationTools` rechtstreeks op de lijst geduwd, buiten `addTools` en
 * buiten de automations-curatie om. Ze tellen hier wél als "start een automation",
 * dus de doorsnede wordt voor hen HIER gemaakt (`_automationIdOf` +
 * `_curatedAutomations`) — anders hangt een tool aan een schakelaar waarvan de
 * belofte niet voor hem geldt.
 *
 * Hij staat NAAST `useTools`, niet eronder: "mag deze stap andere automatiseringen
 * starten" en "mag hij integratietools aanroepen" zijn twee vragen met twee
 * schakelaars, en alleen de eerste aanzetten is een geldige stand. Eén
 * catalogus, elke tool langs de schakelaar die over hem gaat — `extraTools`
 * (bv. `activate_skill`) inbegrepen.
 *
 * ── WAT DE AGENT-KIEZER NOOIT KON TONEN, KRIJGT HIJ HIER NIET ───────
 * `automation-evolution` en `kb-ingest` staan in het registry als
 * `availableTo: ['automation_step']`. De beschikbaarheidsprobe van de agent-kiezer
 * (`routes/agents/toolCatalog.js`) vraagt de catalogus ZONDER `automationStep`, dus
 * geen enkele agent-eigenaar heeft die apps ooit gezien en niemand kan er een
 * grant-entry voor schrijven. Ze dragen ook geen `grantsRequireEntry`, dus
 * `toolPolicy` leest dat zwijgen als de geen-migratieregel en geeft ze
 * `direct`. Op een onbewaakt oppervlak levert dat een agent die tot één
 * leesactie is gecureerd het gereedschap om de automatisering zelf te herschrijven
 * (`automation_apply_evolution` accepteert status 'proposed', dus zonder mens
 * ertussen). Daarom vraagt dit pad de catalogus ZONDER `automationStep`, en
 * weigert het bovendien elke tool waarvan het registry zegt dat hij niet in een
 * agent-context hoort — twee sloten, want het ene is een argument dat iemand
 * terugdraait en het andere leest de declaratie zelf.
 */

'use strict';

const { servesPublishedConfig } = require('../automationModel/agentPublication');
const log = require('../../telemetry/log');
// The unattended-tool deduction (withholdConfirmTools) and its tool readers.
const {
    WITHHOLD_REASONS,
    withholdConfirmTools,
    _resetAgentContextApps,
    _startsAutomation,
    _toolName,
} = require('./aiStepToolWithhold');

/**
 * De organisatie waaraan de agent-poort meet: het LIDMAATSCHAP van de
 * automation-eigenaar, niet de stempel op de automation-rij.
 *
 * `ctx.orgId` is `runOrgFor(automation, session)` — de kolom
 * `automations.organization_id`, met de sessie als terugval. Die stempel loopt
 * NIET mee als een beheerder de eigenaar naar een andere organisatie
 * verplaatst, dus een automatisering van een verhuisde medewerker bleef de
 * gepubliceerde agents van zijn OUDE organisatie oplossen — met hun rol, hun
 * toolgrants en hun kennisbanken. `ctx.userHomeOrgId` is vers uit `users`
 * gelezen (execution.js, dezelfde try als `orgRole` en `identityError`), en de
 * datatable-stap meet daar al aan; dit is dezelfde vraag over dezelfde persoon.
 *
 * Een ctx zonder de sleutel `userHomeOrgId` — de preview-route in
 * `routes/automation/catalog.js` bouwt er een uit het gebruikersrecord van de
 * bewerker — valt terug op `ctx.orgId`, want dáár is dat al het lidmaatschap.
 */
function _viewerOrgId(ctx) {
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, 'userHomeOrgId')) return ctx.userHomeOrgId || null;
    return (ctx && ctx.orgId) || null;
}

/** De drie schakelaars van `ai_step.agentPermissions`. */
const AGENT_PERMISSION_KEYS = Object.freeze(['startAutomations', 'useKnowledge', 'useTools']);

/**
 * De permissies van deze stap, altijd alle drie expliciet.
 *
 * Default FALSE, en dat is geen kopie van de geen-migratieregel uit
 * `toolPolicy`: dit oppervlak is NIEUW, er is geen bestaand gedrag te bewaren,
 * dus onbekend versmalt zonder uitzondering. Een stap zonder (of met een
 * onleesbare) `agentPermissions` krijgt de agent zijn rol en skills, en verder
 * niets wat buiten de stap reikt.
 */
function stepAgentPermissions(step) {
    const raw = (step && typeof step.agentPermissions === 'object' && !Array.isArray(step.agentPermissions))
        ? step.agentPermissions
        : null;
    const out = {};
    for (const key of AGENT_PERMISSION_KEYS) out[key] = raw ? raw[key] === true : false;
    return out;
}

function _fail(message, errorClass) {
    const err = new Error(message);
    err.errorClass = errorClass;
    return err;
}

/**
 * Mag de AUTOMATION-EIGENAAR deze agent inzetten?
 *
 * Dezelfde regels als `routes/agents/chat.js: userCanAccessPublishedAgent`,
 * maar gesteld aan de run-context in plaats van aan een request: een automatisering
 * heeft geen sessie om een org uit te halen en moet het met `ctx` doen.
 *
 *   eigenaar                → ja, ook ongepubliceerd
 *   niet gepubliceerd       → nee — inclusief "wel gedeeld, nooit een versie
 *                             gepubliceerd" (`servesPublishedConfig`)
 *   identiteit onleesbaar   → nee
 *   andere org (of geen org tegenover een org-agent) → nee
 *   gedeeld met groepen     → alleen als de eigenaar in één ervan zit
 *
 * Alle drie de nee's krijgen buiten dezelfde weigering — zie `resolveStepAgent`.
 *
 * `owner_id`-gelijkheid alleen (wat `aiTaskRunner` voor gekoppelde agents doet)
 * is hier te streng — een automatisering mag een gedeelde org-agent inzetten — en
 * `organization_id`-gelijkheid alleen is te ruim: een ongedeelde agent van een
 * collega hoort niet in de automatisering van een ander te draaien.
 */
function _mayUseAgent(agent, ctx) {
    if (!agent) return false;
    const userId = ctx && ctx.userId;
    if (agent.owner_id && userId && agent.owner_id === userId) return true;
    if (!agent.is_published) return false;
    // Gedeeld is nog niet gepubliceerd: zonder een gepubliceerde VERSIE
    // serveert `getForRuntime` het levende klad van de eigenaar, en daar mag de
    // onbewaakte automatisering van een ander niet op draaien.
    if (!servesPublishedConfig(agent)) return false;
    // Een identiteitslezing die niet lukte is geen antwoord. `userHomeOrgId`,
    // `orgRole` en `userGroupIds` komen uit dezelfde lezing (execution.js), dus
    // met `identityError` gezet zijn zowel de org- als de groepsvraag
    // onbeantwoord — en "ik kon het niet nagaan" is hier geen ja. Dezelfde
    // regel die de datatable-stap hanteert; hij komt ná de eigenaarstak, want
    // `owner_id`-gelijkheid heeft geen identiteitslezing nodig.
    if (ctx && ctx.identityError) return false;
    const orgId = _viewerOrgId(ctx);
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return false;
    } else if (agent.organization_id) {
        return false;
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    if (sharedGroups.length === 0) return true;
    // Een groepenlijst die we niet konden lezen (`ctx.identityError`) is leeg,
    // en leeg betekent hier "in geen enkele groep" — de smalle kant.
    const groups = Array.isArray(ctx && ctx.userGroupIds) ? ctx.userGroupIds : [];
    return sharedGroups.some((g) => groups.includes(g));
}

/**
 * Laad de agent achter deze stap, of `null` als de stap er geen heeft.
 *
 * Gooit — nooit stil doorlopen — als er WEL een `agentId` staat en die niet
 * bruikbaar is. De stap is dan zo geconfigureerd dat de agent het denkwerk
 * doet; hem zonder rol, kennis en tools laten antwoorden ziet er van buiten uit
 * als een geslaagde run met een leeg resultaat, en dat is het slechtste van de
 * twee. De save-time-check (`crud.js`) is fail-open en leunt expliciet op deze
 * hercontrole per run.
 */
async function resolveStepAgent(step, ctx, { agentStore = null } = {}) {
    const agentId = step && typeof step.agentId === 'string' ? step.agentId.trim() : '';
    if (!agentId) return null;

    const store = agentStore || require('../../stores/agentStore');
    let agent = null;
    try {
        agent = await store.getForRuntime(agentId);
    } catch (e) {
        // Een lookup die niet lukt is geen "de agent bestaat niet": de stap
        // hoort te falen en opnieuw geprobeerd te kunnen worden, niet zonder
        // agent door te draaien.
        throw _fail(`Could not load the agent for this step (${e.message}).`, 'agent_unavailable');
    }
    // ÉÉN weigering voor alle drie de gevallen — verwijderd, nooit gepubliceerd,
    // of niet gedeeld met de automation-eigenaar. Dezelfde regel die de save-time
    // check aanhoudt (`ai_step.agent_unavailable`, automation/validate/
    // stepRules.js): drie verschillende antwoorden maken van een automatisering een
    // manier om te ontdekken wélke agents er elders bestaan. Het echte verschil
    // gaat naar het serverlog, waar alleen een beheerder het leest.
    if (!agent || !_mayUseAgent(agent, ctx)) {
        log.warn(`[AutomationRunner] ai_step agent refused (${agentId}): ${agent ? 'not visible to the automation owner' : 'no such agent'}`);
        throw _fail(`There is no agent "${agentId}" this automation can use. Pick an agent in the step, or remove it so the step answers on its own prompt.`, 'agent_unavailable');
    }

    const config = (agent.config && typeof agent.config === 'object' && !Array.isArray(agent.config)) ? agent.config : {};
    const systemPrompt = typeof agent.system_prompt === 'string' ? agent.system_prompt.trim() : '';
    return {
        agent,
        agentId: agent.id || agentId,
        config,
        // De bij publicatie gerenderde rol. Niet opnieuw renderen — zie de kop.
        systemPrompt,
        // 'published' of 'live'; het enige eerlijke antwoord op "wat draaide er".
        runtimeSource: agent.runtimeSource || null,
        permissions: stepAgentPermissions(step),
    };
}

/**
 * De kennisbanken van deze stap: die van de stap zelf, plus die van de agent
 * als `useKnowledge` aanstaat.
 *
 * De stap staat VOORAAN zodat zijn eigen keuze de cap (`MAX_AI_STEP_KB_IDS`)
 * overleeft. Autorisatie gebeurt niet hier maar in `execAi`s
 * `resolveAllowedKnowledgeBaseIds`, met de automation-eigenaar als vrager — de
 * hele unie gaat door die ene filter, anders leest een automation-eigenaar via de
 * agent van een collega mee in banken die hij zelf niet mag zien.
 */
function knowledgeBaseIdsForStep(step, binding) {
    const stepIds = Array.isArray(step && step.knowledgeBaseIds) ? step.knowledgeBaseIds : [];
    const agentIds = (binding && binding.permissions.useKnowledge && Array.isArray(binding.config.knowledge_base_ids))
        ? binding.config.knowledge_base_ids
        : [];
    const out = [];
    const seen = new Set();
    for (const id of [...stepIds, ...agentIds]) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * De skills voor deze stap, in de vorm die `buildSkillInjection` verwacht.
 *
 * "Leidend" = de STAP-skill, en dat wordt niet met een extra veld geregeld maar
 * met de volgorde die `mergeSkillIds` al aanhoudt: attached eerst, dan de rest,
 * ontdubbeld, afgekapt op SKILL_CAP. De stap-skills gaan er dus als `attached`
 * in en de agent-skills als `session` — dan wint de stap zowel de volgorde als
 * de cap, zonder dat er iets aan de gedeelde functie hoeft te veranderen.
 */
function skillIdsForStep(step, binding) {
    const clean = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []);
    const attachedSkillIds = clean(step && step.skillIds);
    // Handoff 5: the step can switch individual agent skills off for itself
    // (`disabledAgentSkillIds`). The step's own skills are never affected, and
    // a skill that is both the step's and the agent's stays with the step.
    const disabled = new Set(clean(step && step.disabledAgentSkillIds));
    const own = new Set(attachedSkillIds);
    return {
        attachedSkillIds,
        sessionSkillIds: binding
            ? clean(binding.config.attachedSkillIds).filter((id) => !disabled.has(id) && !own.has(id))
            : [],
    };
}

/**
 * De toolstack voor een agent-gedreven AI-stap.
 *
 * @param {object}   opts
 * @param {object}   opts.binding      het resultaat van `resolveStepAgent`
 * @param {object}   opts.ctx          de run-context (de VRAGER is `ctx.userId`)
 * @param {Array}    [opts.extraTools] tools van buiten de catalogus (bv.
 *   `activate_skill`) — die gaan door dezelfde aftrek EN langs de schakelaar
 *   die over hen gaat, zodat er geen tweede deur naast de poort ligt
 * @param {boolean}  [opts.extraToolsStartAutomations] `extraTools` kunnen een
 *   automatisering starten (een skill met een `automationId` draait
 *   `executeAutomation` zodra het model `activate_skill` aanroept). Dan hangen
 *   ze aan `startAutomations`, net als elke andere automation-starter.
 * @param {string[]|null} [opts.allowList] `step.tools`, als de auteur die
 *   expliciet heeft gezet; kan alleen versmallen
 * @returns {Promise<{tools: Array, withheld: string[], reasons: Object,
 *   degraded: boolean, catalogError: string|null}>}
 */
async function agentToolsForStep({ binding, ctx, extraTools = [], extraToolsStartAutomations = false, allowList = null, skillApps = null, skillAutomationIds = null, deps = {} }) {
    const out = { tools: [], withheld: [], reasons: {}, degraded: false, catalogError: null };
    if (!binding) return out;
    // Handoff 5: what the step's skills grant, already filtered by the step's
    // switches in execAi (aiStepSkills.grantsUnderPermissions). Apps widen the
    // catalog the way a skill does in chat (`extraEnabledApps`); automations join
    // a CURATED agent's automation grants. Both still pass every narrowing below.
    const { configWithSkillAutomations } = require('./aiStepSkills');
    const agentConfig = configWithSkillAutomations(binding.config, skillAutomationIds);
    const gatedBinding = agentConfig === binding.config ? binding : { ...binding, config: agentConfig };
    const dropped = (name, reason) => {
        if (!name) return;
        if (!(name in out.reasons)) out.reasons[name] = reason;
        out.withheld.push(name);
    };

    // Eén catalogus, twee onafhankelijke schakelaars. `startAutomations` gaat
    // over de automatiseringen die de agent mag starten en `useTools` over de rest, dus
    // "alleen automations" is een geldige stand en mag niet stilletjes op nul
    // uitkomen. Zonder allebei wordt er niets opgebouwd — dat scheelt de hele
    // catalogusopbouw op de stap die toch niets krijgt.
    let catalogTools = [];
    if (binding.permissions.useTools || binding.permissions.startAutomations) {
        try {
            const { getIntegrationTools } = deps.integrationTools || require('../integrations/integrationTools');
            // Connection lending (gated, default uit) — dezelfde vorm als
            // execIntegrationAction, zodat de twee catalogi van één run niet
            // uit elkaar lopen.
            const lendPolicy = (ctx.resourceOwnerUserId && ctx.resourceOwnerUserId !== ctx.userId)
                ? { ownerUserId: ctx.resourceOwnerUserId, resourceType: 'automation', resourceId: ctx.automationId || null }
                : null;
            const catalog = await getIntegrationTools({
                userId: ctx.userId,                       // de AUTOMATION-EIGENAAR
                session: ctx.session,
                isAdmin: !!ctx.session?.isAdmin || ctx.session?.user?.role === 'admin',
                // BEWUST UIT — zie de kop. `automationStep` schakelt precies twee
                // dingen aan (`automation-evolution` en `kb-ingest`), en dat zijn
                // de twee apps die de agent-kiezer nooit heeft kunnen tonen. Een
                // agent krijgt hier dus dezelfde apps als in een gesprek, plus
                // niets wat zijn eigenaar nooit heeft kunnen weigeren.
                automationStep: false,
                connectionPolicy: lendPolicy,
                // De per-actie-grants van de agent. Ook het pad waarlangs
                // `tools.automations` de automatiseringsset van de vrager versmalt.
                //
                // `useKnowledge` beslist mee over de KENNIS-helft ervan:
                // `getIntegrationTools` biedt `kb_search` aan op de enkele
                // aanwezigheid van `knowledge_base_ids`, dus een stap met
                // useKnowledge UIT en useTools AAN kreeg een tool die
                // uitdrukkelijk "doorzoek de kennisbank van deze agent" doet.
                // De grants blijven staan; alleen de kennislijst wordt leeg
                // gemaakt, en dat kan alleen versmallen.
                agentConfig: _catalogConfig(gatedBinding),
                // The automations bound to THIS agent are the ones the step may
                // start; the step has no other route to an agent_call automation.
                agentId: binding.agentId || null,
                // Apps the step's skills enable (only when useTools is on; the
                // caller filtered them). Bypasses the personal app toggle only,
                // exactly as in chat; org and group grants still decide.
                extraEnabledApps: Array.isArray(skillApps) && skillApps.length ? skillApps : null,
            });
            catalogTools = Array.isArray(catalog && catalog.tools) ? catalog.tools : [];
        } catch (e) {
            // Een catalogus die niet te bouwen is levert geen tools op. Voor een
            // stap die zonder tools ook een antwoord kan geven is dat het
            // juiste falen: smal, en zichtbaar in het runlog.
            out.catalogError = e && e.message ? e.message : 'integration catalog unavailable';
            log.warn(`[AutomationRunner] ai_step agent tool catalog lookup failed: ${out.catalogError}`);
            catalogTools = [];
        }
    }

    // Elke tool langs de schakelaar die over hem gaat — `extraTools` erbij, want
    // een tool die buiten de catalogus om binnenkomt is geen tool die buiten de
    // schakelaars om binnenkomt. De automation-tools worden op hun eigen marker
    // herkend en niet door `agentConfig` weg te laten: dat zou óók de
    // per-actie-grants op alle andere tools uitzetten, en dat is een verbreding.
    const extras = [];
    for (const t of Array.isArray(extraTools) ? extraTools : []) {
        const name = _toolName(t);
        if (!name || extras.some((x) => _toolName(x) === name)) continue;
        extras.push(t);
    }
    const bySwitch = [];
    for (const t of catalogTools) {
        const allowed = _startsAutomation(t)
            ? binding.permissions.startAutomations
            : binding.permissions.useTools;
        if (allowed) { bySwitch.push(t); continue; }
        dropped(_toolName(t), 'permission');
    }
    for (const t of extras) {
        // Skills horen bij wat de agent IS — die gaan niet achter `useTools`.
        // `activate_skill` is de uitzondering zodra een van de ingespoten skills
        // een automatisering achter zich heeft: `executeActivateSkill` draait dan
        // `executeAutomation(..., mode: 'live')`, en dat is precies waar
        // `startAutomations` over gaat.
        if (extraToolsStartAutomations && !binding.permissions.startAutomations) {
            dropped(_toolName(t), 'permission');
            continue;
        }
        if (bySwitch.some((x) => _toolName(x) === _toolName(t))) continue;
        bySwitch.push(t);
    }

    // Een EXPLICIETE `step.tools` blijft de allowlist die hij op een gewone
    // ai_step ook is: hij kan alleen versmallen. `[]` betekent "geen tools",
    // niet "alles" — zelfde lezing als het bestaande pad in execAi.
    let merged = bySwitch;
    if (Array.isArray(allowList)) {
        const allowed = new Set(allowList.filter((n) => typeof n === 'string' && n));
        merged = merged.filter((t) => allowed.has(_toolName(t)));
    }

    const gate = withholdConfirmTools(merged, gatedBinding.config);
    // Every definition this step was offered or refused, so a reader (the
    // step editor's preview) can say which app a withheld NAME belongs to.
    out.toolDefs = [...catalogTools, ...extras];
    out.tools = gate.tools;
    for (const name of gate.withheld) dropped(name, gate.reasons[name] || 'unavailable');
    out.degraded = gate.degraded;
    if (gate.policyError) out.catalogError = out.catalogError || gate.policyError;
    return out;
}

/**
 * De agentconfig zoals de CATALOGUS hem mag zien.
 *
 * ── DE KENNISLIJST GAAT ER ALTIJD UIT ───────────────────────────────
 * `getIntegrationTools` biedt `kb_search` aan op de enkele AANWEZIGHEID van
 * `knowledge_base_ids`. Dat leverde twee problemen tegelijk. Met
 * `useKnowledge: false` en `useTools: true` kreeg de stap een tool die
 * uitdrukkelijk "doorzoek de kennisbanken van deze agent" doet — de permissie
 * die net was uitgezet. En met `useKnowledge: true` kreeg hij een tool die
 * ALTIJD faalt: de dispatch-context die `execAi` bouwt draagt geen `agentId`,
 * dus `kb_search` leest `getForRuntime(undefined)` en antwoordt "No knowledge
 * base configured".
 *
 * De kennis van de agent bereikt deze stap langs het pad dat er wél voor is:
 * `knowledgeBaseIdsForStep` zet de banken in de unie en `execAi` doorzoekt ze
 * één keer per run, met de automation-eigenaar als vrager. Een tool aanbieden die
 * niet kan werken is een belofte aan het model die nergens heen kan, dus hij
 * wordt niet aangeboden. (Wil je hem later wél: geef `agentId` mee in de
 * dispatch-context van execAi — maar dan zet dat ook `datatable_query` aan, en
 * dat is een tweede beslissing.)
 *
 * De grants gaan onaangeroerd mee: die weglaten zou de per-actie-beperkingen op
 * álle tools uitzetten. Een ondiepe kopie — `binding.config` is de gedeelde
 * runtime-projectie en mag niet gemuteerd worden.
 */
function _catalogConfig(binding) {
    const config = binding.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    if (!Array.isArray(config.knowledge_base_ids) || config.knowledge_base_ids.length === 0) return config;
    return { ...config, knowledge_base_ids: [] };
}

module.exports = {
    AGENT_PERMISSION_KEYS,
    WITHHOLD_REASONS,
    _resetAgentContextApps,
    stepAgentPermissions,
    resolveStepAgent,
    knowledgeBaseIdsForStep,
    skillIdsForStep,
    withholdConfirmTools,
    agentToolsForStep,
};
