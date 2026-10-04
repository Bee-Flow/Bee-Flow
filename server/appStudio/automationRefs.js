/**
 * "Welke knop van deze app draait welke automation" — puur.
 *
 * Dit is de LEESKANT van de nieuwe index `automation_usage` (P4 deel C). Hij
 * beantwoordt precies één vraag over één app-definitie: welke automatiseringen noemt
 * zij, vanaf welke knop, op welk scherm. De schrijfkant staat in
 * `appStudio/automationUsageSync.js`, de tabel in
 * `stores/automationUsageStore.js`.
 *
 * ── WAAROM DIT GEEN VELD IN `automation_datatable_usage` IS ──────────
 *
 * Die index is per TABEL-DOEL gekeyd, en dat is een FK, geen conventie:
 * `datatable_id TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE`
 * (stores/datatableStore.js). Een app→automation-rij heeft geen datatable, dus er
 * is geen waarde die daar in mag; `reconcileUsageFor` schrijft via
 * `INSERT … SELECT … FROM datatables d WHERE d.id = $6`, dus zonder tabelrij
 * schrijft hij NUL rijen en noemt zichzelf geslaagd. Dat is precies de stille
 * poort die deze hele familie moet voorkomen. Vandaar een eigen tabel.
 *
 * ── DE SLEUTEL IS DE ACTIE, NIET DE STAP ─────────────────────────────
 *
 * Een sequence-stap heeft GEEN id — `containsStepKind` (validate/actions.js)
 * loopt hem op positie af. Een positie als halve primaire sleutel is precies
 * wat W5 verbiedt: bij elke bewerking schuift hij op, schrijft de reconcile een
 * nieuwe rij en groeit de index tot hij niets meer betekent. De ACTIE heeft wél
 * een stabiel id (`act_xxxx`, afgedwongen door validate.js' checkId), dus de
 * rij is er één per (app, actie, automation). Twee `run_automation`-stappen in
 * dezelfde sequence die dezelfde automatisering draaien zijn één rij; draaien ze
 * verschillende automatiseringen, dan zijn het er twee — het automation_id zit in de
 * sleutel.
 *
 * ── EEN ONBEDRAADE ACTIE TELT WEL MEE ────────────────────────────────
 *
 * Een actie die aan een automatisering hangt maar aan geen enkele knop
 * (`action.unreachable` in de validator) levert een rij MET een leeg
 * knop-adres. De verleiding is hem over te slaan — er kan immers niemand op
 * drukken — maar de index is wat een verwijdering luidruchtig maakt, en daar
 * geldt dezelfde richting als bij W5: een rij te veel maakt een verwijdering
 * luidruchtiger, een rij te weinig maakt hem stil. `wired:false` zegt het
 * verschil, zodat het scherm "nog niet aan een knop gekoppeld" kan tonen in
 * plaats van een verzonnen knopnaam.
 *
 * ── ÉÉN VOCABULAIRE, TWEE LOPEN ──────────────────────────────────────
 *
 * `collectReferencedActions` (validate/nodes.js) weet welke acties bereikbaar
 * zijn, maar geeft alleen de ids terug — niet de knop. Deze module loopt
 * dezelfde boom nóg een keer om de KNOP erbij te zoeken, met dezelfde
 * gebeurtenisnamen (`EVENT_NAMES`, geïmporteerd) en dezelfde vier
 * actielijst-props (gespiegeld, want die zijn daar niet geëxporteerd — zelfde
 * afweging als `NAMING_PROPS` in appRefLookup.js). Dat de twee lopen niet uit
 * elkaar lopen is geen belofte maar een test: automationUsageSync.test.js
 * vergelijkt de sleutelverzameling met `collectReferencedActions` over een
 * fixture die élke bedradingsvorm bevat.
 */

'use strict';

const { EVENT_NAMES } = require('./componentSpecs');
const { nodeOwnText } = require('./appRefLookup');

/**
 * De props waarin een component een actie bij ID noemt in plaats van via een
 * gebeurtenis. Gespiegeld uit validate/nodes.js#collectReferencedActions; zie
 * de kop voor waarom dat een spiegel is en niet een import.
 */
const ACTION_LIST_PROPS = Object.freeze(['itemActions', 'rowActions', 'bulkActions', 'toolbarActions']);

/** Het voorvoegsel van `ref_id`. Zie de kop: de ACTIE is de sleutel. */
const REF_PREFIX = 'act:';

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * De automatiseringen die één actie draait, in volgorde van eerste voorkomen.
 *
 * Zowel de v1-vorm (`kind:'run_automation'` op de actie zelf) als de
 * sequence-stap. De recursie is exact die van `containsStepKind`
 * (validate/actions.js): `steps`, `then`, `else`, `cases[].steps` en
 * `default` — de VIJF plekken waar een stap een stap kan bevatten. Dat "exact"
 * is geen belofte maar een test: automationUsageSync.test.js vergelijkt de
 * twee recursies veld voor veld.
 *
 * @returns {{ids: string[], unset: number}} `unset` telt de
 *   `run_automation`-plekken zónder automatisering (`automationId: null`, de stand
 *   waarin elk sjabloon wordt uitgeleverd). Die zijn GEEN gebruik, maar ze
 *   horen wel in de logregel.
 */
function automationsInAction(action) {
    const ids = [];
    let unset = 0;
    const seen = new Set();

    const take = (obj) => {
        const aid = obj && typeof obj.automationId === 'string' ? obj.automationId.trim() : '';
        if (!aid) { unset += 1; return; }
        if (seen.has(aid)) return;
        seen.add(aid);
        ids.push(aid);
    };

    const walkSteps = (steps, depth) => {
        // Dezelfde diepterem als de validator (MAX_ACTION_STEP_DEPTH is daar
        // een fout, hier alleen een stop): een handgeschreven definitie mag
        // deze scan niet in een cyclus trekken.
        if (!Array.isArray(steps) || depth > 12) return;
        for (const step of steps) {
            if (!isObject(step)) continue;
            if (step.kind === 'run_automation') take(step);
            walkSteps(step.steps, depth + 1);
            walkSteps(step.then, depth + 1);
            walkSteps(step.else, depth + 1);
            for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
                if (isObject(c)) walkSteps(c.steps, depth + 1);
            }
            // `default` — de VIJFDE ingang, en degene die hier ontbrak. Zowel
            // de browser (runtime/useActionRunner: `execSteps(hit ? hit.steps
            // : step.default)`) als de server (appStudio/actionSequence.js)
            // voert die tak echt uit, dus een automatisering die er alleen daar in
            // staat, draaide wel en stond niet in de index — en dan zegt de
            // capsule "No app button runs this automation yet" op het scherm
            // waarop iemand besluit hem te verwijderen.
            walkSteps(step.default, depth + 1);
        }
    };

    if (!isObject(action)) return { ids, unset };
    if (action.kind === 'run_automation') take(action);
    walkSteps(action.steps, 1);
    return { ids, unset };
}

/**
 * Welke KNOP elke actie aanzet: actie-id → { screenId, nodeId, label }.
 *
 * De EERSTE vindplaats in documentvolgorde wint. Twee knoppen op dezelfde
 * actie is één plek in de app die de automatisering draait — de rij noemt de eerste,
 * en dat is eerlijker dan een tweede rij die net doet alsof het twee
 * verschillende koppelingen zijn.
 */
function collectActionSites(screens) {
    const sites = new Map();
    const remember = (actionId, screenId, node) => {
        if (typeof actionId !== 'string' || !actionId) return;
        if (sites.has(actionId)) return;
        sites.set(actionId, {
            screenId: screenId || null,
            nodeId: typeof node?.id === 'string' ? node.id : null,
            label: nodeOwnText(node),
        });
    };

    const visit = (node, screenId) => {
        if (!isObject(node)) return;
        for (const ev of EVENT_NAMES) {
            if (typeof node[ev] === 'string' && node[ev]) remember(node[ev], screenId, node);
        }
        const props = isObject(node.props) ? node.props : {};
        for (const key of ACTION_LIST_PROPS) {
            for (const entry of (Array.isArray(props[key]) ? props[key] : [])) {
                if (isObject(entry) && typeof entry.actionId === 'string') remember(entry.actionId, screenId, node);
            }
        }
        if (typeof props.addRowActionId === 'string') remember(props.addRowActionId, screenId, node);
        for (const col of (Array.isArray(props.columns) ? props.columns : [])) {
            if (isObject(col) && typeof col.actionId === 'string') remember(col.actionId, screenId, node);
        }
        for (const child of (Array.isArray(node.children) ? node.children : [])) visit(child, screenId);
    };

    for (const screen of (Array.isArray(screens) ? screens : [])) {
        if (!isObject(screen)) continue;
        const screenId = typeof screen.id === 'string' ? screen.id : null;
        for (const section of (Array.isArray(screen.sections) ? screen.sections : [])) {
            if (!isObject(section)) continue;
            for (const child of (Array.isArray(section.children) ? section.children : [])) visit(child, screenId);
        }
    }
    return sites;
}

/**
 * Elke (actie, automatisering) die deze definitie noemt.
 *
 * Puur en defensief: een misvormde actie wordt overgeslagen, nooit op gegooid.
 * Een definitie die geen object is levert een LEGE lijst — en de aanroeper
 * mag dat NIET als "deze app gebruikt niets" lezen zonder eerst te weten dat
 * de definitie echt gelezen is. Zie regel 1 in automationUsageSync.js.
 *
 * @returns {{entries: Array<{automationId:string, refId:string, actionId:string,
 *            screenId:string|null, nodeId:string|null, label:string|null,
 *            wired:boolean}>, unset:number}}
 */
function collectAutomationRefs(definition) {
    const def = isObject(definition) ? definition : {};
    const actions = isObject(def.actions) ? def.actions : {};
    const sites = collectActionSites(def.screens);

    const entries = [];
    let unset = 0;
    for (const [actionId, action] of Object.entries(actions)) {
        if (typeof actionId !== 'string' || !actionId) continue;
        const found = automationsInAction(action);
        unset += found.unset;
        const site = sites.get(actionId) || null;
        for (const automationId of found.ids) {
            entries.push({
                automationId,
                refId: `${REF_PREFIX}${actionId}`,
                actionId,
                screenId: site ? site.screenId : null,
                nodeId: site ? site.nodeId : null,
                label: site ? site.label : null,
                // Zie de kop: een onbedrade actie telt mee, maar zegt dat ook.
                wired: !!site,
            });
        }
    }
    return { entries, unset };
}

module.exports = {
    collectAutomationRefs,
    collectActionSites,
    automationsInAction,
    ACTION_LIST_PROPS,
    REF_PREFIX,
};
