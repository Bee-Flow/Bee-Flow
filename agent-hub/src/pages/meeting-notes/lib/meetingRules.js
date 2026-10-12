import { segmentForSection } from '../../../components/admin/Studio/studioRoutes';

/**
 * Wat een REGEL op een vergadernotitie is, afgelezen van de automation zelf
 * (M5, deel D). De prose staat in RulesPanel.jsx; hier staat alleen wat waar
 * is, zodat de kaart geen enkele bewering hoeft te verzinnen.
 *
 * Een regel is een automation met een `app_event`-trigger op provider
 * `meeting-notes` — de declaratie in server/automation/triggerSources/declared/
 * meeting-notes.js. De lijst komt van `GET /api/automation?triggerProvider=…`
 * en bevat per contract alleen de eigen automatiseringen van de lezer
 * (`getAutomationsForUser` is `WHERE user_id = $1`).
 *
 * ── HET ONBEKENDE VALT NIET WEG ──────────────────────────────────────
 * Twee plekken beslissen wat een kaart mag zeggen, en allebei werken ze met
 * een ALLOW-list zodat het onbekende opvalt in plaats van te verdwijnen:
 *
 *   consequencesOf   drie stapsoorten worden benoemd (`knowledge_write`,
 *                    `notification`, een `datatable` die SCHRIJFT); een
 *                    expliciete lijst stapsoorten verandert niets buiten de
 *                    run; al het overige wordt GETELD, zodat de zin kan zeggen
 *                    dat er meer gebeurt dan er staat. Een stapsoort die er
 *                    volgend jaar bij komt valt vanzelf in die laatste bak.
 *
 *   triggerConditionOf  leest `tags` en `reprocessed`; élke andere sleutel in
 *                    het filter — de DSL-combinatoren any/none/expr/age uit
 *                    triggers/dslFilters.js, en wat er later bij komt — zet
 *                    `extra`, want die versmalt de regel op een manier die
 *                    deze zin niet draagt.
 */

export const RULE_TRIGGER_PROVIDER = 'meeting-notes';
export const RULE_TRIGGER_EVENT = 'meeting.processed';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/* ── de trigger ──────────────────────────────────────────────────────── */

/**
 * De meeting-notes-triggers van een definitie.
 *
 * Spiegelt `appEventTriggersOf` in routes/automation/crud.js: de primaire
 * trigger PLUS de extra entry-points in `triggers[]`, want een app_event mag
 * daar ook staan en zo'n tweede trigger laat de regel evengoed vuren.
 */
export function meetingTriggersOf(definition) {
    const all = [definition?.trigger, ...list(definition?.triggers)];
    return all.filter(t => isObject(t) && t.kind === 'app_event' && t.appEvent?.provider === RULE_TRIGGER_PROVIDER);
}

/** Een tagwaarde uit een filter → lijst. Spiegelt `asTagList` van de matcher. */
function asTagList(v) {
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    return raw.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

// Wat deze kaart uit een trigger-filter kan lezen. Een ALLOW-list, geen
// deny-list: een nieuwe sleutel is dan vanzelf "er is meer aan de hand".
const FILTER_KNOWN_KEYS = new Set(['tags', 'reprocessed']);

/**
 * De voorwaarde van een regel, of NULL als dit geen meeting-notes-regel is.
 *
 * `tags` is een VERENIGING over de triggers, want de matcher matcht op ANY of
 * them en meerdere triggers vuren elk apart. `extra` betekent "smaller dan
 * deze zin zegt" en staat aan zodra een filter iets bevat wat we niet lezen,
 * óf zodra twee triggers een verschillende `reprocessed`-stand hebben (dan is
 * er geen enkele stand die voor de hele regel waar is).
 */
export function triggerConditionOf(definition) {
    const triggers = meetingTriggersOf(definition);
    if (!triggers.length) return null;

    const tags = [];
    const seen = new Set();
    const reprocessedSeen = new Set();
    const events = new Set();
    let extra = false;

    for (const trigger of triggers) {
        events.add(typeof trigger.appEvent?.event === 'string' ? trigger.appEvent.event : '');
        const filter = isObject(trigger.appEvent?.filter) ? trigger.appEvent.filter : {};
        for (const tag of asTagList(filter.tags)) {
            if (seen.has(tag)) continue;
            seen.add(tag);
            tags.push(tag);
        }
        reprocessedSeen.add(filter.reprocessed === true ? true : (filter.reprocessed === false ? false : undefined));
        for (const key of Object.keys(filter)) {
            if (!FILTER_KNOWN_KEYS.has(key) && filter[key] !== undefined) extra = true;
        }
    }

    if (reprocessedSeen.size > 1) extra = true;
    const reprocessed = reprocessedSeen.size === 1 ? [...reprocessedSeen][0] : undefined;
    // Het EVENT reist mee. `meetingTriggersOf` filtert bewust alleen op de
    // PROVIDER, zodat een later `meeting.scheduled` vanzelf in deze lijst komt
    // — maar dan mag de zin niet onvoorwaardelijk "… is finished" zeggen. Die
    // zin schaalde niet mee en vertelde over elk toekomstig event het verhaal
    // van `meeting.processed`. Vandaag al bereikbaar: validate/graph.js maakt
    // van een onbekend app_event-event een WARNING, geen error, dus een
    // geïmporteerde definitie met een verzonnen event landt in deze lijst.
    const onlyProcessed = events.size === 1 && events.has(RULE_TRIGGER_EVENT);
    return { tags, reprocessed, extra, events: [...events], onlyProcessed };
}

/* ── de consequenties ────────────────────────────────────────────────── */

// Schrijf-ops van een datatable-stap (validate/constants.js
// DATATABLE_WRITE_OPS). Met de hand overgenomen, net als daar: een nieuwe
// LEES-op mag niet stilletjes een schrijver worden. Een stap zónder `op`, of
// met een op die we niet kennen, telt daarom als onbekend en niet als lezer.
const DATATABLE_WRITE_OPS = new Set(['add_row', 'save_row', 'update_rows', 'delete_rows']);
const DATATABLE_READ_OPS = new Set(['find_rows', 'count_rows']);

/**
 * Stapsoorten die niets buiten de run veranderen: rekenen, vertakken,
 * omzetten, wachten. Ze horen niet in de consequentie-zin en ze zijn ook geen
 * "er gebeurt meer" — daarom staan ze hier met naam en toenaam. Alles wat noch
 * hier noch in de drie benoemde soorten staat, wordt geteld en gemeld.
 *
 * `call_layer` staat erbij omdat de inhoud van die layer apart wordt gelopen
 * (definition.layers) — anders zou hij dubbel tellen. `call_block` staat er
 * NIET bij: een Reusable Step woont in een ander document en wat hij doet is
 * van hieruit onbekend.
 */
const NO_OUTWARD_EFFECT = new Set([
    'trigger', 'note',
    'condition', 'switch', 'guard', 'filter', 'flatten', 'limit', 'dedupe', 'aggregate', 'summarize',
    'set', 'datetime', 'parse_json', 'wait',
    'tokenize', 'untokenize',
    'loop', 'parallel', 'call_layer', 'layer_output',
    // `ai_step` staat hier ALLEEN voor de tool-loze variant: `reachesOutward`
    // hieronder wordt eerst gevraagd en haalt de bewapende eruit. `code` staat
    // er bewust NIET bij — die krijgt onvoorwaardelijk een HTTP-brug.
    'ai_step',
]);

/**
 * `ai_step` en `code` stonden hierboven, en dat was fail-open: allebei kunnen
 * ze de INTEGRATIETOOLS van de gebruiker echt uitvoeren.
 *   - execAi.js opent de toolcatalogus zodra `step.allowTools` waar is en
 *     draait daarna een tool-loop met `executeTool`. Zonder die vlag is het
 *     een kale modelaanroep en verandert er buiten de run niets.
 *   - execOutbound.js geeft een code-stap ALTIJD een HTTP-brug (`fetchHttp`),
 *     los van `step.allowedTools`. Een code-stap reikt dus altijd naar buiten.
 * Een regel met één `ai_step {allowTools:true, tools:['gmail_send_email']}`
 * mailde de klant de besluiten uit de notitie terwijl de kaart letterlijk
 * "nothing yet — this rule has no steps" toonde.
 */
function reachesOutward(step) {
    if (step.type === 'code') return true;
    if (step.type !== 'ai_step') return false;
    // Een expliciete allowlist telt ook mee: vandaag doet hij zonder
    // `allowTools` niets, maar de bedoeling is duidelijk en onbekend versmalt.
    return !!step.allowTools || (Array.isArray(step.tools) && step.tools.length > 0);
}

/**
 * Elke stap van elke graaf: top-level, loop-body, parallelle tak.
 *
 * GEEN `step.cases`. Zo ziet een switch er in dit product niet uit: de
 * validator documenteert `cases: [{ name, value }]` — een ARRAY van
 * BESCHRIJVINGEN — en de takken zelf lopen via EDGE-labels, niet via nesting.
 * De canonieke nested-walker (validate/graph.js) kent dan ook maar twee
 * containers: `loop.body` en `parallel.branches`. Een tak die `cases` als map
 * behandelde vuurde nooit op een echte switch en wekte alleen de indruk dat
 * switch-nesting gedekt was.
 */
function walkSteps(steps, visit) {
    for (const step of list(steps)) {
        if (!isObject(step)) continue;
        visit(step);
        if (Array.isArray(step.body)) walkSteps(step.body, visit);
        if (Array.isArray(step.branches)) for (const branch of step.branches) walkSteps(branch, visit);
    }
}

/**
 * Wat er met de notitie gebeurt, afgeleid uit de stapsoorten.
 *
 * `readable: false` betekent dat er geen stappenlijst IN de definitie zat —
 * dat is iets anders dan een regel zonder stappen, en de kaart zegt het
 * anders. (`definition_json` wordt server-side met een fallback geparsed, dus
 * een onleesbare definitie komt hier aan als een object zonder `steps`.)
 */
export function consequencesOf(definition) {
    if (!isObject(definition) || !Array.isArray(definition.steps)) {
        return { readable: false, kb: false, notify: false, table: false, other: 0, steps: 0 };
    }
    // `steps` telt ELKE stap, ook de inerte. "Geen stappen" en "alleen stappen
    // die deze kaart als inert bestempelt" zijn verschillende antwoorden, en de
    // kaart maakte er één zin van: een regel met set + condition + parse_json
    // kreeg "this rule has no steps" terwijl er drie stappen stonden.
    const out = { readable: true, kb: false, notify: false, table: false, other: 0, steps: 0 };

    const visit = (step) => {
        const type = typeof step.type === 'string' ? step.type : '';
        if (type !== 'trigger') out.steps += 1;
        if (type === 'knowledge_write') { out.kb = true; return; }
        if (type === 'notification') { out.notify = true; return; }
        if (type === 'datatable') {
            if (DATATABLE_WRITE_OPS.has(step.op)) out.table = true;
            else if (!DATATABLE_READ_OPS.has(step.op)) out.other += 1;
            return;
        }
        if (reachesOutward(step)) { out.other += 1; return; }
        if (NO_OUTWARD_EFFECT.has(type)) return;
        out.other += 1;
    };

    walkSteps(definition.steps, visit);
    const layers = isObject(definition.layers) ? Object.values(definition.layers) : [];
    for (const layer of layers) if (isObject(layer)) walkSteps(layer.steps, visit);
    return out;
}

/* ── openen en tellen ────────────────────────────────────────────────── */

/**
 * Mag de lezer deze regel openen? 'ok' | 'foreign' | 'unknown'.
 *
 * `GET /api/automation/:id` is een harde eigendomscheck (403 zodra
 * `a.userId !== req.session.user.id`), dus alleen een POSITIEVE match geeft
 * een link. Geen eigenaar in de rij, of geen bekende lezer, is 'unknown': dan
 * is er geen link én geen bewering over wiens regel het is.
 *
 * Bewust STRENGER dan `isForeignRow` van UsedByTab, dat "geen eigenaar
 * bekend" als "niet van iemand anders" leest: daar is de rij org-breed en
 * klopt die kant op, hier is het doelwit een route die op precies dat
 * verschil 403 geeft.
 */
export function openability(row, currentUserId) {
    const owner = row?.userId ?? row?.ownerId ?? null;
    if (!owner || !currentUserId) return 'unknown';
    return owner === currentUserId ? 'ok' : 'foreign';
}

/** Waar de regel woont. Uit de segmentkaart die de router zelf leest. */
export function ruleHref(automationId) {
    if (!automationId) return null;
    return `studio/${segmentForSection('aiTasks')}/${encodeURIComponent(automationId)}`;
}

/**
 * De telling voor één automatisering, of NULL als die er niet is.
 *
 * `/_runs/facets` telt `r.user_id = <ik>` (stores/automationStore/runs.js
 * buildRunFilterWhere) — MIJN runs, niet die van de organisatie; de org-variant
 * is een ander endpoint met een eigen permissiecheck. Elke zin die dit getal
 * gebruikt moet dus zeggen wiens runs het zijn.
 */
export function runCountOf(facets, automationId) {
    const byId = facets?.automationId;
    if (!isObject(byId)) return null;          // onleesbaar — zie facetsReadable
    const n = byId[automationId];
    return Number.isFinite(n) ? n : 0;         // gelezen en niet gevonden = een echte nul
}

/**
 * Is dit facetten-antwoord te lezen?
 *
 * Een 200 met een body zonder `automationId`-map is GEEN nul: dan heeft niemand
 * geteld. `runCountOf` gaf voor beide `null` en de kaart maakte er "no runs of
 * yours" van — een bewering over runs die niet geteld zijn. Het paneel gebruikt
 * dit om dezelfde banner te tonen als bij een mislukte lees.
 */
export function facetsReadable(facets) {
    return isObject(facets) && isObject(facets.automationId);
}

/* ── nieuwe regel ────────────────────────────────────────────────────── */

/**
 * Het concept dat "+ Rule" aanmaakt: de trigger staat al goed, de rest niet.
 *
 * Een LEEG filter, met opzet: dat betekent élke afgeronde vergadernotitie, en
 * het filterformulier in de builder zegt dat met zoveel woorden zodra je er
 * bent (triggerFilters.jsx). Een verzonnen tagfilter zou een regel maken die
 * stilletjes minder doet dan de auteur denkt.
 */
export function newRuleDefinition() {
    return {
        schemaVersion: 1,
        trigger: {
            id: 'trg',
            type: 'trigger',
            kind: 'app_event',
            label: 'Meeting note ready',
            appEvent: { provider: RULE_TRIGGER_PROVIDER, event: RULE_TRIGGER_EVENT, filter: {} },
        },
        steps: [],
        edges: [],
        vars: {},
    };
}

/* ── de AI-composer ──────────────────────────────────────────────────── */

/**
 * De seed die de suggestie-scan binnen dit onderwerp houdt.
 *
 * De server knipt `focus` af op 280 tekens (routes/ai/automationBuilder/
 * suggestions.js), dus de seed staat VOORAAN: wat de gebruiker erbij typt mag
 * wegvallen, de scope niet.
 */
export const COMPOSER_SEED = 'Rules that run on a finished Bee Flow meeting note (trigger: Meeting Notes, meeting.processed). Prefer steps that file the note in a knowledge base, send a notification, or write a datatable row.';

export function composerSeed(userText) {
    const extra = typeof userText === 'string' ? userText.replace(/\s+/g, ' ').trim() : '';
    return extra ? `${COMPOSER_SEED} Wanted: ${extra}` : COMPOSER_SEED;
}
