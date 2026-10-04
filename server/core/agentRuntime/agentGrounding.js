'use strict';

/**
 * Waar een agent zijn antwoord op kán baseren — ÉÉN regel, drie lezers.
 *
 * ── WAAROM DIT EEN EIGEN BESTAND IS ────────────────────────────────────────
 *
 * De regel bestond al: routes/studio/attentionChecks.js `evaluateAgentNoKb`
 * maakt er de "Vraagt aandacht"-melding van op het Start-scherm van Studio
 * (H3). De kaartvoet van het agentoverzicht (A5) moet exact dezelfde zin
 * kunnen zeggen — "Antwoordt uit het hoofd — koppel een kennisbank" — en dat
 * mag geen tweede implementatie worden. Twee implementaties van één regel
 * lopen uit elkaar, en het eerste scherm waar dat opvalt is precies het
 * scherm waar iemand ze naast elkaar ziet: Start zegt "vraagt aandacht" en
 * het overzicht zegt niets over dezelfde agent.
 *
 * Dus staat het criterium hier, zonder afhankelijkheden, en lezen
 * `routes/studio/attentionChecks.js` (het aandachtspunt),
 * `routes/agents/published.js` (het veld `grounding` op elke rij van
 * GET /agents/all) én `./personaPrompt.js` (de kennispoort van
 * `applyPersonaToConfig`) hem allemaal hier. Zuiver, zodat elke kant hem met
 * platte objecten kan testen.
 *
 * ── DRIE WAARDEN PER AS, EN DE DERDE IS DE REDEN ───────────────────────────
 *
 *   true   deze bron is aangesloten
 *   false  gekeken, en er is er geen
 *   null   NIET TE LEZEN — de sleutel staat er, maar in een vorm waar niets
 *          uit af te leiden valt (een string waar een lijst hoort)
 *
 * `null` is nadrukkelijk geen `false`. "Deze agent heeft geen kennisbank" is
 * een BEWERING met een opdracht eraan vast; "ik kon zijn bedrading niet
 * lezen" is er geen. De aandachtslijst maakt van de tweede een genoemd gat
 * (`agents:config`) en de kaartvoet zwijgt erover — allebei versmallen ze,
 * geen van beide vult een nul in.
 *
 * ── TWEE ASSEN, EN WAAROM WEBSEARCH ER GEEN IS ─────────────────────────────
 *
 * Tot A5 keek deze regel alleen naar `knowledge_base_ids`. Een agent met
 * alleen een tabelgrant werd dus gemeld als "antwoordt uit het model alleen",
 * en dat is onwaar: `core/tools/datatableTools.js` geeft hem echt iets om in
 * te kijken. Vandaar de tweede as.
 *
 * Een DERDE as op `config.enabledIntegrations` (websearch) stond hier even,
 * en is er weer uit omdat hij niets meet. Nagegaan in de bron:
 *
 *   - `core/agentRuntime/toolStackAssembly.js` geeft de agentconfig door aan
 *     `getIntegrationTools`, maar dáár wordt alleen `config.tools` gelezen
 *     (de automation-curatie). Welke apps een agent krijgt hangt aan
 *     `enabled_apps_user_<id>` — de GEBRUIKER — plus `AUTO_ENABLED_APPS`,
 *     waar `agent-search` in staat, plus of er überhaupt een zoekprovider
 *     geconfigureerd is (`searchAvailable`). Buiten aiTaskRunner (automation-
 *     OAuth), automationAuth en de packaging leest niemand in server/ het veld
 *     `config.enabledIntegrations`.
 *   - `stores/agent/initSchema.js` (R4-backfill) heeft `agent-search` in
 *     ÉLKE agentrij van vóór die migratie gezet. Als "web staat aan" zou
 *     gelden als grond, dan was zowat elke bestaande agent gegrond zonder dat
 *     er iets aan hem veranderd is.
 *
 * Allebei de kanten falen dus: op een self-host zonder zoekprofiel zou de as
 * een agent "gegrond" noemen die aantoonbaar uit het model alleen antwoordt,
 * en op een deploy mét zoekprovider heeft praktisch elke agent websearch
 * terwijl de as `false` zegt. Een as die in beide richtingen liegt is geen as.
 *
 * ── DE CONFIG IS DE WAARHEID, EN DAN OOK DE SPELLING DIE DE RUNTIME LEEST ──
 *
 * `applyPersonaToConfig` (./personaPrompt.js) kan web beloven zonder dat de
 * runtime het aanbiedt; wat de runtime aanbiedt staat in de config. Voor de
 * kennisbanken betekent dat óók: alleen `config.knowledge_base_ids`.
 * `core/agentRuntime/knowledgeSearch.js` doet
 * `agent.config?.knowledge_base_ids || []` en kent GEEN camelCase-tak, dus een
 * rij die alleen `knowledgeBaseIds` draagt levert daar nul doorzochte
 * kennisbanken op. Die als bron meetellen zou een agent "gegrond" noemen die
 * elke beurt niets doorzoekt.
 */

/**
 * Sleutels die nooit een tabelgrant zijn. Spiegel van `UNSAFE_OBJECT_KEYS` in
 * agent-hub/…/canUse/canUseFacts.js: `JSON.parse('{"__proto__":{}}')` levert
 * een eigen sleutel op, en zonder deze zeef zou zo'n config als "gegrond op
 * een tabel" lezen terwijl de runtime er niets mee doet.
 */
const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Een as die uit een LIJST komt.
 *
 * Afwezig (`undefined`/`null`) ⇒ `false`: een config zonder die sleutel heeft
 * die bron echt niet. Aanwezig maar geen lijst ⇒ `null`: er staat iets, we
 * weten alleen niet wat.
 */
function listAxis(raw, matches) {
    if (raw === undefined || raw === null) return false;
    if (!Array.isArray(raw)) return null;
    return raw.some(matches);
}

/**
 * De tabel-as: `config.tools.datatables`, met dezelfde vormcontrole die
 * toolPolicy.js's `_datatableGrants` doet (`_plainObject`, anders niets).
 * Twee niveaus, en op allebei geldt: er staat iets onleesbaars ⇒ `null`.
 */
function tablesAxis(config) {
    const tools = config.tools;
    if (tools === undefined || tools === null) return false;
    if (!isPlainObject(tools)) return null;
    const grants = tools.datatables;
    if (grants === undefined || grants === null) return false;
    if (!isPlainObject(grants)) return null;
    return Object.keys(grants).some(id => !UNSAFE_OBJECT_KEYS.has(id));
}

/**
 * Waar deze agentconfig op gegrond is, per bron.
 *
 * @param {object|null|undefined} config de GEPARSEERDE config-kolom
 * @returns {{kb: boolean|null, tables: boolean|null}}
 *   Een config die zelf geen object is levert twee keer `null` — dat is
 *   "onleesbaar", en de aanroeper hoort dat als een gat te melden, niet als
 *   een agent zonder bronnen.
 */
function groundedOn(config) {
    if (!isPlainObject(config)) return { kb: null, tables: null };
    return {
        // Alleen snake_case: dat is de sleutel die knowledgeSearch.js leest.
        // Zie de kop — een camelCase-lijst wordt nooit doorzocht, dus die is
        // geen bron. Een lege string of alleen spaties telt ook niet mee: die
        // levert `getKnowledgeBase` niets op.
        kb: listAxis(config.knowledge_base_ids, v => typeof v === 'string' && v.trim() !== ''),
        tables: tablesAxis(config),
    };
}

/**
 * Het oordeel over de assen, als één woord.
 *
 *   'grounded'    minstens één bron staat vast aan
 *   'ungrounded'  alle assen zijn gelezen en alle zijn leeg
 *   null          minstens één as was niet te lezen ⇒ geen oordeel
 *
 * De volgorde telt: één harde `true` maakt de agent gegrond, ook als een
 * andere as onleesbaar was — die kan er immers alleen nóg een bron bij doen.
 * Andersom mag één onleesbare as nooit tot "gegrond op niets" leiden.
 *
 * @param {{kb: boolean|null, tables: boolean|null}} axes
 * @returns {'grounded'|'ungrounded'|null}
 */
function groundingVerdict(axes) {
    const values = [axes?.kb, axes?.tables];
    if (values.some(v => v === true)) return 'grounded';
    if (values.every(v => v === false)) return 'ungrounded';
    return null;
}

/** `groundedOn` + `groundingVerdict` in de vorm die over de API reist. */
function groundingOf(config) {
    const axes = groundedOn(config);
    return { ...axes, verdict: groundingVerdict(axes) };
}

/**
 * Noemt deze config een KENNISBANK — iets waar "antwoord alleen uit je
 * kennis" over kan gaan?
 *
 * DE KB-AS ALLEEN, en dat is met opzet smaller dan `groundingVerdict`. De
 * vlag die hierop hangt is `strictKnowledge`, en `contextBuilder.js` maakt
 * daar een CRITICAL OPERATIONAL CONSTRAINT van die elke andere instructie
 * overrulet zodra er geen "KNOWLEDGE BASE RESULTS"-sectie is. Die sectie
 * bouwt `knowledgeSearch.js` uitsluitend uit `config.knowledge_base_ids`: een
 * tabelgrant levert er geen, hoe echt die bron verder ook is. Zou een
 * tabel-agent hier meetellen, dan zette de eerlijkheidskeuze hem op weigeren
 * — óók voor vragen over de tabel die hij net gekregen heeft.
 *
 * `null` (onleesbaar) telt hier als AFWEZIG, en dat is de eerlijke lezing
 * voor deze ene vraag: een config die we niet konden lezen mag nooit het
 * ding zijn dat een agent stilletjes op weigeren zet.
 */
function hasKnowledgeSource(config) {
    return groundedOn(config).kb === true;
}

module.exports = {
    groundedOn,
    groundingVerdict,
    groundingOf,
    hasKnowledgeSource,
};
