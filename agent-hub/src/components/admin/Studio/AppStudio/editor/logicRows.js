import { eventText } from './nodeLogicSummary';
import { nOf } from '../../KnowledgeStudio/plural';
import { describeAction } from '../inspector/actionLabels';
import { TYPE_EVENT_LISTS } from '../inspector/styleKnobMeta';
import { NODE_EVENTS } from '../state/definitionOps';

/**
 * De rijen van de Logica-tab: één tabel over ALLE schermen van "wanneer" ×
 * "wat er dan gebeurt".
 *
 * De oude Logica-weergave (collectLogicMarks in nodeLogicSummary.js) liep
 * alleen over NODE_EVENTS en sloeg elk slot met een falsy actie over. Daardoor
 * toonde hij precies de helft die al goed was, en verzweeg hij de helft waar
 * een bouwer naar zoekt:
 *
 *   • een event dat een component WEL kan maar dat aan niets hangt
 *     (data_grid onRowClick, kanban onCardMove, elke input-onChange,
 *     approval_list onDecided) — geen regel, geen waarschuwing, niets;
 *   • de vier andere actie-oppervlakken die de server WEL als bereikbaar telt
 *     (validate/nodes.js collectReferencedActions): rowActions, itemActions,
 *     bulkActions, toolbarActions, props.addRowActionId en
 *     props.columns[].actionId;
 *   • een actie in `definition.actions` waar niets naar wijst — serverzijdig
 *     een `action.unreachable`-waarschuwing, hier vroeger onzichtbaar.
 *
 * Stil weglaten is de fout die dit scherm moet oplossen, dus komt ALLES in de
 * tabel en draagt elke rij zelf of hij bedraad is (`wired`). De tab tekent een
 * onbedrade rij gestippeld en hangt er de save-melding aan die de server over
 * dat component stuurde.
 *
 * → [{ key, kind, wired, when, what, ... }] in leesvolgorde: per scherm, eerst
 * de beschrijvende "scherm opent"-regel, dan de componenten in canvasvolgorde.
 */

/** Zelfde stand-in voor t() als nodeLogicSummary/dryRunIssues — zie daar. */
const EN_ONLY = (key, en, params) => (params && typeof params === 'object'
    ? Object.entries(params).reduce(
        (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
        String(en),
    )
    : en);

/**
 * De vier lijst-oppervlakken plus de twee losse, in de woorden waarin ze
 * gebeuren. Dit is dezelfde verzameling die collectReferencedActions
 * (server/appStudio/validate/nodes.js) als "bereikbaar" telt — de rolpoort
 * (studioAppRunGate.js) en de oude Logica-weergave kenden er maar een deel
 * van, en dat verschil is precies waar een actie onzichtbaar werd.
 */
const SURFACE_LISTS = ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions'];

function surfaceWhen(t, surface) {
    switch (surface) {
        case 'rowActions': return t('app_studio.logic.when_row_action', 'When a row action is used');
        case 'itemActions': return t('app_studio.logic.when_item_action', 'When an item action is used');
        case 'bulkActions': return t('app_studio.logic.when_bulk_action', 'When a bulk action is used');
        case 'toolbarActions': return t('app_studio.logic.when_toolbar_action', 'When a toolbar button is used');
        case 'addRowActionId': return t('app_studio.logic.when_add_row', 'When a new row is added');
        case 'columnAction': return t('app_studio.logic.when_cell_action', 'When a cell action is used');
        default: return surface;
    }
}

/** De triggersoort van een automatisering, in een zin. */
function triggerWhen(t, kind) {
    switch (kind) {
        case 'schedule': return t('app_studio.logic.when_schedule', 'On a schedule');
        case 'webhook': return t('app_studio.logic.when_webhook', 'When a webhook arrives');
        case 'app_event': return t('app_studio.logic.when_app_event', 'When data in the app changes');
        case 'app_trigger': return t('app_studio.logic.when_app_trigger', 'When this app calls it');
        case 'agent_call': return t('app_studio.logic.when_agent_call', 'When an agent calls it');
        case 'manual': return t('app_studio.logic.when_manual', 'When someone runs it by hand');
        default: return t('app_studio.logic.when_other_trigger', 'When its own trigger fires');
    }
}

/** Welke events dit componenttype MAG dragen — leeg voor een type zonder events. */
export function eventsForType(type) {
    const list = TYPE_EVENT_LISTS[type];
    return Array.isArray(list) ? list : [];
}

/**
 * De eventslots van DIT component: wat het type mag dragen, PLUS elk slot dat
 * er daadwerkelijk in staat.
 *
 * Alleen de typelijst is niet genoeg, en dat is de reden dat deze functie
 * bestaat. De server loopt per NAAM over élk node (validate/nodes.js, EVENT_NAMES
 * + collectReferencedActions) en de canvasbadge doet dat óók (nodeLogicSummary
 * loopt NODE_EVENTS). Een bedraad slot buiten de typelijst — een type dat een
 * event uit zijn spec verliest terwijl opgeslagen definities het slot houden,
 * of een install/import die niet door PUT /:id/definition ging — viel bij deze
 * tab uit de tabel én maakte zijn actie tot "wees": van de drie lezers verborg
 * juist het scherm dat is gebouwd omdat er niets stil mag verdwijnen de
 * bedrading, mét de omgekeerde bewering ("Nothing starts this yet") erbij.
 *
 * De volgorde blijft die van het type; wat er extra in staat komt erachteraan.
 */
export function eventSlotsOf(node) {
    const slots = eventsForType(node?.type).slice();
    for (const event of NODE_EVENTS) {
        if (slots.includes(event)) continue;
        if (typeof node?.[event] === 'string' && node[event]) slots.push(event);
    }
    return slots;
}

/**
 * Elke `tableId` die ergens in de props van dit scherm/deze app gebonden is.
 *
 * Diep gelopen in plaats van per bindingsoort uitgelezen: de soortenlijst
 * (componentSpecs/bindings.js BINDING_KINDS) is gesloten maar staat op de
 * server, en een binding zit soms twee lagen diep (kolomfilters, geneste
 * aggregaties). Een object met een string-`tableId` IS een tabelbinding, in
 * welke soort hij ook zit — dat blijft waar als er een soort bij komt.
 */
export function collectBoundTableIds(root) {
    const ids = new Set();
    const seen = new Set();
    const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (typeof value.tableId === 'string' && value.tableId) ids.add(value.tableId);
        for (const key of Object.keys(value)) {
            if (key === 'tableId') continue;
            walk(value[key]);
        }
    };
    walk(root);
    return ids;
}

/** Alle componenten van één scherm, plat, met hun definitiepad erbij. */
function nodesOfScreen(screen, screenIndex) {
    const out = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        out.push({ node, path });
        const children = Array.isArray(node.children) ? node.children : [];
        children.forEach((child, i) => walk(child, `${path}.children[${i}]`));
    };
    (Array.isArray(screen?.sections) ? screen.sections : []).forEach((section, s) => {
        (Array.isArray(section?.children) ? section.children : []).forEach((child, c) => {
            walk(child, `screens[${screenIndex}].sections[${s}].children[${c}]`);
        });
    });
    return out;
}

function actionsOf(definition) {
    return definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};
}

/**
 * Wat er achter een actie-id zit, in de taal van de auteur — of, als de actie
 * er niet is, dat gezegd. `describeAction` naamt; dat er NIETS te naamen valt
 * is een andere mededeling en mag niet als naam doorgaan.
 */
function whatOf(t, actionId, definition, titleFor) {
    const action = actionsOf(definition)[actionId];
    if (!action) return t('app_studio.canvas.mark_missing_action', 'points at an action that no longer exists');
    return describeAction(actionId, action, definition, titleFor);
}

function baseRow(extra) {
    return {
        kind: 'event',
        wired: true,
        screenId: null,
        screenName: '',
        nodeId: null,
        nodeType: null,
        event: null,
        surface: null,
        surfaceLabel: null,
        actionId: null,
        actionKind: null,
        automationId: null,
        path: '',
        descriptive: false,
        ...extra,
    };
}

/**
 * De beschrijvende regel "Scherm wordt geopend".
 *
 * AFWIJKING VAN HET ARTBOARD, bewust. Het artboard tekent deze regel tussen de
 * andere in, alsof er een `onScreenOpen`-event bestaat. Dat bestaat niet:
 * EVENT_NAMES (server/appStudio/componentSpecs/screenSpec.js) kent zeven
 * events en geen daarvan hangt aan een scherm, en de runtime laadt data omdat
 * een component een BINDING heeft, niet omdat iemand iets bedraadde. Een
 * nieuw event verzinnen zou een slot opleveren dat de server weigert
 * (`event.not_supported`) en de AI-builder zou kunnen "bedraden" zonder dat er
 * ooit iets afgaat. Dus: afgeleid uit de databindingen, gemarkeerd als
 * `descriptive`, en de tab tekent hem zonder bedradingsaffordance — je kunt
 * hem niet aanklikken om er een actie aan te hangen, want er is niets om aan
 * te hangen.
 *
 * Geen bindingen op het scherm → geen regel. Er gebeurt dan werkelijk niets
 * bij het openen, en "niets gebeurt er" als rij is ruis, geen informatie.
 */
function screenOpenRow(t, screen, screenIndex, nodes) {
    const loaders = nodes.filter(({ node }) => collectBoundTableIds(node.props).size > 0);
    if (!loaders.length) return null;
    const tables = new Set();
    for (const { node } of loaders) for (const id of collectBoundTableIds(node.props)) tables.add(id);
    return baseRow({
        key: `screen:${screen.id}`,
        kind: 'screen_open',
        descriptive: true,
        screenId: screen.id,
        screenName: screen.name || '',
        path: `screens[${screenIndex}]`,
        when: t('app_studio.logic.when_screen_opens', 'When the screen is opened'),
        // Geen tabelNAMEN: die staan achter een fetch, niet in de definitie
        // (dezelfde reden als bij actionLabels' create_record). Het aantal
        // componenten is wat de definitie wél weet en is niet minder waar.
        what: nOf(
            t, 'app_studio.logic.screen_loads', loaders.length,
            '{count} component loads its data', '{count} components load their data',
        ),
        loaderCount: loaders.length,
        tableIds: [...tables],
    });
}

/**
 * De twee manieren waarop een rij in de tabel belandt.
 *
 * `wired` legt de actie erachter vast EN onthoudt dat er iets naar die actie
 * wijst — dezelfde reached-set die validate.js gebruikt om `action.unreachable`
 * te bepalen. `plain` is de gestippelde rij: een slot dat bedraad KAN worden en
 * dat niet is.
 */
function makeEmitter({ rows, definition, titleFor, t, referenced }) {
    const actions = actionsOf(definition);
    return {
        plain(row) {
            rows.push(baseRow({ ...row, wired: false, what: t('app_studio.logic.no_action_yet', 'No action yet') }));
        },
        wired(row, actionId) {
            const action = actions[actionId];
            referenced.add(actionId);
            rows.push(baseRow({
                ...row,
                wired: true,
                actionId,
                actionKind: action?.kind || null,
                automationId: action?.kind === 'run_automation' ? (action.automationId || null) : null,
                what: whatOf(t, actionId, definition, titleFor),
            }));
        },
    };
}

/**
 * Elk event-slot dat dit componenttype MAG dragen, bedraad of niet.
 *
 * De onbedrade helft is de kern van dit scherm. Vandaag verdwijnt zo'n slot
 * spoorloos: de canvasbadge slaat een falsy actionId over
 * (nodeLogicSummary.js), "Logic n" telt hem niet mee, en de validator zwijgt
 * erover op een knop en een formulier na. Hij blijft hier dus staan.
 */
function emitEventRows(node, common, emit, t) {
    for (const event of eventSlotsOf(node)) {
        const actionId = typeof node[event] === 'string' && node[event] ? node[event] : null;
        const row = { ...common, key: `${node.id}:${event}`, event, when: eventText(t, event) };
        if (actionId) emit.wired(row, actionId);
        else emit.plain(row);
    }
}

/**
 * De zes actie-oppervlakken naast de events: vier lijsten plus addRowActionId
 * en columns[].actionId. Dit is de lijst uit collectReferencedActions
 * (server/appStudio/validate/nodes.js); de rolpoort en de oude weergave kenden
 * er maar een deel van.
 *
 * Een lege actionId in een lijst is de inspector's eigen "nog niet
 * bedraad"-stand — validate/nodes.js laat hem expliciet toe — dus die telt als
 * onbedraad en niet als kapot.
 */
function emitSurfaceRows(node, common, emit, t) {
    const props = (node.props && typeof node.props === 'object') ? node.props : {};
    const { path } = common;
    for (const listKey of SURFACE_LISTS) {
        (Array.isArray(props[listKey]) ? props[listKey] : []).forEach((entry, i) => {
            if (!entry || typeof entry !== 'object') return;
            const row = {
                ...common,
                key: `${node.id}:${listKey}[${i}]`,
                surface: listKey,
                surfaceLabel: labelOf(entry),
                path: `${path}.props.${listKey}[${i}].actionId`,
                when: surfaceWhen(t, listKey),
            };
            if (typeof entry.actionId === 'string' && entry.actionId) emit.wired(row, entry.actionId);
            else emit.plain(row);
        });
    }
    if (typeof props.addRowActionId === 'string' && props.addRowActionId) {
        emit.wired({
            ...common,
            key: `${node.id}:addRowActionId`,
            surface: 'addRowActionId',
            path: `${path}.props.addRowActionId`,
            when: surfaceWhen(t, 'addRowActionId'),
        }, props.addRowActionId);
    }
    (Array.isArray(props.columns) ? props.columns : []).forEach((col, i) => {
        if (!col || typeof col !== 'object') return;
        if (typeof col.actionId !== 'string' || !col.actionId) return;
        emit.wired({
            ...common,
            key: `${node.id}:columns[${i}]`,
            surface: 'columnAction',
            surfaceLabel: labelOf(col),
            path: `${path}.props.columns[${i}].actionId`,
            when: surfaceWhen(t, 'columnAction'),
        }, col.actionId);
    });
}

/** Het eigen label van een rij-/kolomactie, of niets als er geen is. */
function labelOf(entry) {
    return typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
}

/**
 * Alle rijen voor de tabel, in leesvolgorde.
 *
 * `titleFor(automationId)` naamt een automatisering; wie hem niet heeft krijgt
 * "Run automation" onopgesmukt, zoals overal elders.
 */
export default function logicRows(definition, { titleFor = null, t = EN_ONLY } = {}) {
    const rows = [];
    /** Elke actie waar iets naar wijst — de reached-set van validate.js. */
    const referenced = new Set();
    const emit = makeEmitter({ rows, definition, titleFor, t, referenced });

    (Array.isArray(definition?.screens) ? definition.screens : []).forEach((screen, screenIndex) => {
        const nodes = nodesOfScreen(screen, screenIndex);
        const opener = screenOpenRow(t, screen, screenIndex, nodes);
        if (opener) rows.push(opener);
        for (const { node, path } of nodes) {
            const common = {
                screenId: screen.id,
                screenName: screen.name || '',
                nodeId: node.id || null,
                nodeType: node.type || null,
                path,
            };
            emitEventRows(node, common, emit, t);
            emitSurfaceRows(node, common, emit, t);
        }
    });

    // Acties waar niets naar wijst. De server geeft hier een
    // `action.unreachable`-waarschuwing over af (validate.js) en de oude
    // weergave liet ze weg — waardoor een automatisering die je net koos nergens te
    // zien was en je hem een tweede keer toevoegde.
    for (const [actionId, action] of Object.entries(actionsOf(definition))) {
        if (referenced.has(actionId)) continue;
        rows.push(baseRow({
            key: `orphan:${actionId}`,
            kind: 'orphan_action',
            wired: false,
            actionId,
            actionKind: action?.kind || null,
            automationId: action?.kind === 'run_automation' ? (action.automationId || null) : null,
            path: `actions.${actionId}`,
            when: t('app_studio.logic.when_nothing', 'Nothing starts this yet'),
            what: whatOf(t, actionId, definition, titleFor),
        }));
    }

    return rows;
}

/**
 * Hoort deze automatisering bij deze app? Drie voorwaarden, alle drie versmallend:
 * hij staat in dezelfde oplossing, hij hangt nog niet aan een knop (dan staat
 * hij hierboven al) en hij raakt een tabel waar de app aan gebonden is.
 */
function belongsToApp(row, { projectId, tables, wired }) {
    if (!row?.id || row.projectId !== projectId) return false;
    if (wired.has(row.id)) return false;
    return automationTouchesTables(row, tables);
}

/** Een Set van wat er binnenkomt: een Set blijft zichzelf, een lijst wordt er een. */
function asSet(value) {
    if (value instanceof Set) return value;
    return new Set(Array.isArray(value) ? value : []);
}

/** De triggersoort van een routinerij, zoals AutomationPicker hem ook leest. */
function triggerKindOf(row) {
    return row?.definition?.trigger?.kind || row?.triggerType || 'manual';
}

/**
 * Raakt deze automatisering een van deze tabellen?
 *
 * Een `datatable`-stap draagt `datatableId` (of `datatableKey`); een
 * tabeltrigger draagt zijn tabel in `trigger.filter.tableId`. Stappen kunnen
 * genest zijn (loop-body, if/else, switch-cases), dus de walk gaat er doorheen
 * — een automatisering die alleen ín een lus naar de tabel schrijft raakt hem net zo
 * goed.
 */
export function automationTouchesTables(row, tableIds) {
    if (!(tableIds instanceof Set) || tableIds.size === 0) return false;
    const hit = (v) => typeof v === 'string' && v && tableIds.has(v);
    if (hit(row?.definition?.trigger?.filter?.tableId)) return true;
    let found = false;
    const walk = (steps) => {
        for (const step of Array.isArray(steps) ? steps : []) {
            if (found) return;
            if (!step || typeof step !== 'object') continue;
            if (hit(step.datatableId) || hit(step.datatableKey) || hit(step.tableId)) { found = true; return; }
            walk(step.then); walk(step.else); walk(step.steps); walk(step.default);
            for (const c of Array.isArray(step.cases) ? step.cases : []) walk(c?.steps);
        }
    };
    walk(row?.definition?.steps);
    return found;
}

/**
 * "Automations van deze app" — automatiseringen in DEZELFDE OPLOSSING die de tabellen
 * raken waar deze app aan gebonden is.
 *
 * AFWIJKING VAN HET ARTBOARD, bewust. Het artboard toont dit als een lijst die
 * bij de app hoort, alsof de app een veld "mijn automations" heeft. Dat veld
 * bestaat niet en moet ook niet bestaan: een tweede plek waar staat welke
 * automatiseringen bij een app horen is een tweede waarheid die stil uit de pas loopt
 * zodra iemand de automatisering hernoemt, verplaatst of weggooit. De lijst is dus
 * AFGELEID uit twee dingen die al waar zijn — `app.projectId` (de oplossing
 * waar de app in gearchiveerd staat, studioAppStore.mapAppMetaRow) en de
 * tabellen die de definitie bindt.
 *
 * Beide voorwaarden zijn nodig. Alleen "zelfde oplossing" zou elke automatisering in
 * de map opsommen, ook de nachtelijke factuurmail die niets met deze app te
 * maken heeft; alleen "raakt de tabel" zou automatiseringen van collega's uit andere
 * oplossingen binnenhalen. Een app ZONDER oplossing (`projectId` null) levert
 * daarom een lege lijst op — "alle automatiseringen die deze tabel raken" is een
 * andere vraag, en het antwoord daarop achteloos hier neerzetten is precies de
 * verbreding die dit scherm niet mag doen.
 *
 * Automatiseringen die al aan een knop hangen komen NIET terug: die staan hierboven
 * al, met de knop erbij. Wat overblijft is het antwoord op "welke van MIJN
 * automatiseringen draaien er nog meer op deze gegevens" — en dat was nergens te zien.
 *
 * DERDE VERSMALLING, en die zit niet hier maar in de bron: `automationRows`
 * komt van GET /api/automation → getAutomationsForUser (`WHERE user_id = $1`),
 * dus dit zijn de automatiseringen van de KIJKER. De nachtelijke automatisering van een
 * collega, in dezelfde oplossing en op dezelfde tabel, staat er niet in. Dat
 * mag — maar dan moet de kop het zeggen, want een lege sectie is niet te
 * onderscheiden van "die zijn er niet". LogicaTab zet er daarom "Your automatiseringen
 * in this solution" boven en noemt de uitsluiting in de ondertitel.
 */
export function derivedAutomationRows({ app, automationRows, boundTableIds, wiredAutomationIds = null, t = EN_ONLY } = {}) {
    const projectId = app?.projectId || null;
    if (!projectId) return [];
    const tables = asSet(boundTableIds);
    if (!tables.size) return [];
    const wired = asSet(wiredAutomationIds);
    const rows = [];
    for (const row of Object.values(automationRows || {})) {
        if (!belongsToApp(row, { projectId, tables, wired })) continue;
        rows.push(baseRow({
            key: `automation:${row.id}`,
            kind: 'automation',
            wired: true,
            automationId: row.id,
            actionKind: 'run_automation',
            when: triggerWhen(t, triggerKindOf(row)),
            what: row.title || t('app_studio.inspector.tile_unnamed', 'This automation'),
        }));
    }
    return rows;
}

/**
 * De save-meldingen die over DEZE rij gaan.
 *
 * Gematcht op het definitiepad dat de server meestuurt, niet op de tekst: de
 * zin mag herschreven worden, het pad is de identiteit. Een melding op het
 * component zelf (`screens[0]…children[2]`) hoort bij elke rij van dat
 * component; een melding op een dieper pad (`…props.rowActions[1].actionId`)
 * alleen bij de rij die daar precies over gaat.
 */
export function noticesForRow(notices, row) {
    if (!Array.isArray(notices) || !row?.path) return [];
    return notices.filter((n) => matchNotice(row, n) !== null);
}

/**
 * Hoe goed hoort deze melding bij deze rij? → `null` als hij er niet bij hoort.
 *
 * Drie soorten treffer, en de rangorde erna is niet dezelfde:
 *   2 — het pad is IDENTIEK. Altijd de beste.
 *   1 — de melding zit DIEPER dan de rij (`…rowActions[1].actionId` onder een
 *       component). De meest SPECIFIEKE rij wint: het langste pad.
 *   0 — de melding zit HOGER dan de rij (een melding over het component, de rij
 *       is een van zijn oppervlakken). Dan wint de EERSTE rij van dat component,
 *       zoals de doc hieronder belooft — niet de diepste, die toevallig het
 *       langste pad heeft.
 *
 * EEN BESCHRIJVENDE RIJ VANGT ALLEEN ZICHZELF. "Scherm wordt geopend" draagt het
 * pad van het SCHERM (`screens[0]`), en dat is een voorvader van élk component
 * erop. Zonder deze uitzondering landde een melding over een component dat geen
 * enkele logica-rij oplevert (een input_text, een kop, een plaatje) op die ene
 * regel: de bouwer las "input_text sits outside a form" onder "When the screen is
 * opened / 2 components load their data" en ging het verkeerde component zoeken.
 * Zulke meldingen horen bij geen enkele rij en blijven in de save-pill staan —
 * precies wat de kop van assignNotices al beweerde.
 */
function matchNotice(row, notice) {
    const rowPath = typeof row?.path === 'string' ? row.path : '';
    const path = typeof notice?.path === 'string' ? notice.path : '';
    if (!rowPath || !path) return null;
    if (path === rowPath) return { tier: 2, len: rowPath.length };
    if (row.descriptive) return null;
    if (path.startsWith(`${rowPath}.`)) return { tier: 1, len: rowPath.length };
    if (rowPath.startsWith(`${path}.`)) return { tier: 0, len: 0 };
    return null;
}

/**
 * Elke melding aan PRECIES ÉÉN rij, de meest specifieke.
 *
 * Een component met twee eventslots en drie rijacties levert vijf rijen op, en
 * `component.control_inert` past op alle vijf. Vijf keer dezelfde zin onder
 * elkaar is geen nadruk maar ruis, en het maakt de rij die de melding écht
 * bedoelt onvindbaar. Het langste matchende pad wint: een melding over
 * `…props.rowActions[1].actionId` hoort bij die ene rijactie, een melding over
 * het component zelf bij de eerste rij ervan.
 *
 * → Map van rij-key naar meldingen. Een melding die bij geen enkele rij hoort
 * (app-brede paden zoals `meta.name`) valt hier weg en blijft in de save-pill
 * staan, waar hij thuishoort.
 */
export function assignNotices(rows, notices) {
    const byRow = new Map();
    for (const notice of Array.isArray(notices) ? notices : []) {
        let best = null;
        let bestScore = null;
        for (const row of Array.isArray(rows) ? rows : []) {
            const score = matchNotice(row, notice);
            if (!score) continue;
            // Strikt groter: bij gelijke score wint de EERSTE rij in
            // leesvolgorde, en dat is wat tier 0 nodig heeft.
            if (!bestScore || score.tier > bestScore.tier
                || (score.tier === bestScore.tier && score.len > bestScore.len)) {
                best = row; bestScore = score;
            }
        }
        if (!best) continue;
        const list = byRow.get(best.key) || [];
        list.push(notice);
        byRow.set(best.key, list);
    }
    return byRow;
}

/**
 * Hoeveel BEDRADE logica deze app draagt — het getal in het "Logic n"-segment
 * van de kop (EditorHeader).
 *
 * Staat hier en niet in nodeLogicSummary, omdat de kop en de tab anders
 * verschillende dingen tellen. Dat was ook zo: `countLogicMarks` telde alleen
 * bedrade NODE_EVENTS, terwijl deze tabel er zes actie-oppervlakken bij heeft.
 * Een data_grid waarvan alle logica in `rowActions` + `toolbarActions` zit gaf
 * dus 0 — het segment liet het getal weg, het signaal "hier valt niets te zien",
 * boven een tabel met vier regels. Eén bron, en `logicRows` is die bron.
 *
 * Wat NIET meetelt: de beschrijvende "scherm opent"-regel (die is afgeleid, niet
 * bedraad) en elk onbedraad slot of weesje (die staan in de tabel juist omdat er
 * nog niets gebeurt — ze zijn geen logica die iemand aanzette).
 */
export function countWiredLogic(definition) {
    return logicRows(definition).filter((row) => row.wired && !row.descriptive).length;
}
