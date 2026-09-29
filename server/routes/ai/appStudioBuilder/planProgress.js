/**
 * Tick the App Studio builder's plan checklist from what the tool calls did.
 *
 * Same reason as the routine builder's planProgress.js: the prompt asks the
 * model to bundle app_set_plan({markDone}) with every build call, and the
 * small local models do not — a finished app with the checklist at 0/6 is
 * not a progress view. So the ROUTE infers progress from the tool results it
 * already has, deterministically and additively: the model's own markDone
 * still works, this only ever adds. Never un-ticks.
 *
 * Evidence, per tool (the arithmetic is core/llm/planChecklist's two-shared-
 * tokens rule, so "Add the Facturen table" does not tick on the word "table"
 * alone):
 *   app_set_meta / app_set_theme      → naming, theme, look, preset items
 *   app_link_datatable / upsert_table → the table's name/key + link/table words
 *   app_add_screen                    → the screen's name + screen/page words
 *   app_add_components                → per landed component: type synonyms
 *                                       (English and the Dutch the owner types)
 *                                       + its label
 *   app_set_action / bind_action      → action words + the action's name/kind
 *   app_finalize                      → everything (the build is over)
 */

'use strict';

const { makeTokenizer, DEFAULT_STOP } = require('../../../core/llm/planChecklist');

const STOP = new Set([...DEFAULT_STOP, 'app', 'component', 'components', 'bind', 'binding', 'show', 'toon', 'display', 'alle', 'all']);
const base = makeTokenizer(STOP);

// Dutch writes compounds where English writes two words: "detailscherm",
// "factuurpagina", "filterbalk". Each such token also yields its head, so
// "Detailscherm per factuur" meets a screen named "Factuur detail".
const COMPOUND_TAILS = ['scherm', 'pagina', 'balk', 'tabel', 'lijst', 'overzicht', 'tegel', 'grafiek'];
function tokens(text) {
    const out = new Set(base.tokens(text));
    for (const t of [...out]) {
        for (const tail of COMPOUND_TAILS) {
            if (t.length > tail.length + 2 && t.endsWith(tail)) { out.add(t.slice(0, -tail.length)); out.add(tail); }
        }
    }
    return out;
}
function matchesItem(itemText, evidence, min = 2) {
    const it = tokens(itemText);
    if (!it.size) return false;
    return base.overlap(it, evidence) >= min;
}

// Words a plan item uses for a component type — English and Dutch, because
// the checklist is written in the language of the brief.
const TYPE_WORDS = {
    data_grid: 'table grid rows list overview tabel overzicht lijst rijen',
    table: 'table grid tabel',
    list: 'list lijst',
    stat: 'kpi tile tiles total totals count sum tegel tegels totaal totalen aantal som statistiek stat',
    chart: 'chart graph bar line pie trend grafiek diagram maand month per',
    filter_bar: 'filter filters search zoek zoeken filterbalk',
    record_detail: 'detail record details detailscherm',
    form: 'form formulier invoer input',
    button: 'button knop action actie',
    heading: 'heading title titel kop header',
    page_header: 'header page title titel kop',
    text: 'text tekst paragraph toelichting',
    kanban: 'kanban board bord',
    calendar: 'calendar kalender agenda',
    input_text: 'field input veld invoer',
    input_select: 'select dropdown keuze',
    input_date: 'date datum',
    card: 'card kaart panel',
    callout: 'callout notice melding',
};

const RX = {
    theme: /\b(theme|thema|look|style|stijl|preset|kleur|colou?r|identity|huisstijl|design)\b/i,
    name: /\b(name|naam|noem|title|titel|meta)\b/i,
    finalize: /finali[sz]e|afronden|publish|publiceer|save the app|opslaan/i,
    link: /\b(link|koppel|connect|verbind|attach|source|bron)\b/i,
    table: /\b(table|tabel|datatable|data)\b/i,
    action: /\b(action|actie|button|knop|wire|click|klik|navigate|navigeer|open)\b/i,
    screen: /\b(screen|scherm|page|pagina)\b/i,
};

/**
 * @param {Array<{text:string, done:boolean}>} todos
 * @param {{ name:string, args:object, result:object }} call
 * @returns {number[]} indices to mark done (sorted, only currently-open items)
 */
function inferAppPlanProgress(todos, { name, args, result } = {}) {
    if (!Array.isArray(todos) || !todos.length || !result || typeof result !== 'object' || result.error) return [];
    const open = todos.map((t, i) => ({ i, text: String((t && t.text) || '') })).filter(t => !todos[t.i].done && t.text);
    if (!open.length) return [];
    const hit = new Set();
    const tick = (pred) => { for (const o of open) if (!hit.has(o.i) && pred(o.text)) hit.add(o.i); };
    const a = args && typeof args === 'object' ? args : {};

    switch (name) {
        case 'app_set_meta':
            tick(t => RX.name.test(t));
            break;
        case 'app_set_theme':
            tick(t => RX.theme.test(t));
            break;
        case 'app_link_datatable':
        case 'app_upsert_table': {
            // A LINK item ("Koppel de tabel Facturen") is this tool's; an item
            // that merely shows the table ("Tabel met alle facturen") is the
            // component's. The link word decides, then the table's own name.
            const tbl = result.table || {};
            const ev = tokens([tbl.name, tbl.key, result.key, a.name, a.key].filter(Boolean).join(' '));
            const creating = name === 'app_upsert_table';
            tick(t => (RX.link.test(t) || (creating && /\b(create|maak|new|nieuwe)\b/i.test(t))) && RX.table.test(t) && (matchesItem(t, ev, 1) || !ev.size));
            break;
        }
        case 'app_add_screen': {
            const ev = tokens([a.name, 'screen scherm page pagina'].filter(Boolean).join(' '));
            tick(t => matchesItem(t, ev));
            break;
        }
        case 'app_add_components': {
            const added = Array.isArray(result.added) ? result.added : [];
            for (const c of added) {
                if (!c || !c.type) continue;
                const label = c.label || (a.components || []).find(x => x && x.type === c.type && x.props && (x.props.title || x.props.label || x.props.text));
                const labelText = typeof label === 'string' ? label : (label && label.props ? (label.props.title || label.props.label || label.props.text) : '');
                const ev = tokens([TYPE_WORDS[c.type] || c.type.replace(/_/g, ' '), labelText].filter(Boolean).join(' '));
                tick(t => !RX.link.test(t) && matchesItem(t, ev));
            }
            break;
        }
        case 'app_set_action':
        case 'app_bind_action': {
            const act = (a.action && typeof a.action === 'object') ? a.action : {};
            const ev = tokens([act.name, act.kind, a.event, 'action actie button knop wire'].filter(Boolean).join(' '));
            tick(t => matchesItem(t, ev) || (RX.action.test(t) && !RX.screen.test(t) && !RX.table.test(t) && !RX.theme.test(t)));
            break;
        }
        case 'app_finalize':
            if (result.finalized) for (const o of open) hit.add(o.i);
            else tick(() => false);
            break;
        default:
            break;
    }
    return [...hit].sort((x, y) => x - y);
}

module.exports = { inferAppPlanProgress, TYPE_WORDS, _internals: { tokens, matchesItem } };
