import { describeAction } from '../inspector/actionLabels';
import { NODE_EVENTS } from '../state/definitionOps';

/**
 * What logic a component carries, in a sentence each.
 *
 * The canvas drew components and nothing else. A screen with a dozen of them
 * gave no clue which button does something when clicked, which field refuses a
 * bad value, which card is hidden from most people — you found out by selecting
 * each one in turn and opening three inspector accordions. For a builder who
 * cannot read the definition JSON, "what does what" was answerable only by
 * exhaustive clicking, and a rule attached to the wrong component was invisible
 * until somebody used the app.
 *
 * → [{ key, kind, text }], most important first. Empty when a node is plain,
 * which is most of them — the marks have to stay rare enough to mean something.
 *
 * `kind` is the badge to draw: 'action' | 'visibility' | 'enablement' |
 * 'validation' | 'computed'. `text` is the whole explanation, already in the
 * author's language (describeAction does the naming), so a tooltip needs no
 * further assembly.
 */

/**
 * The stand-in for t() when a caller has none: `countLogicMarks` only counts
 * marks, and the unit tests call this module straight. Same contract as
 * useTranslation's `t(key, english, params)` — it hands back the English and
 * fills the {placeholders} in, so a summary reads exactly as it did before
 * this module learned to translate.
 */
const EN_ONLY = (key, en, params) => (params && typeof params === 'object'
    ? Object.entries(params).reduce(
        (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
        String(en),
    )
    : en);

/**
 * The event slots, in the words a person reads them in. The wordings are the
 * inspector's own (`app_studio.inspector.when_*`) — the same sentence in two
 * places is one key, not two. Exported for the same reason: the Logic tab
 * (editor/logicRows.js) heads its "When" column with these exact sentences,
 * and a second copy of the switch is a third answer waiting to drift.
 *
 * `onChange` is in NODE_EVENTS like the other five (state/definitionOps.js),
 * so the `default` arm is not a theoretical branch — it printed the raw
 * JavaScript property name, `onChange`, into a sentence a builder reads. It
 * was left out on the grounds that it "never had a wording here", but the
 * wording exists one module over and is already in both dictionaries, so the
 * choice was between a word and an identifier rather than between two words.
 * `default` now covers only a slot that does not exist yet, which is the only
 * thing it should ever have covered.
 */
export function eventText(t, event) {
    switch (event) {
        case 'onClick': return t('app_studio.inspector.when_clicked', 'When clicked');
        case 'onSubmit': return t('app_studio.inspector.when_submitted', 'When submitted');
        case 'onRowClick': return t('app_studio.inspector.when_row_clicked', 'When a row is clicked');
        case 'onRowSelect': return t('app_studio.inspector.when_row_selected', 'When a row is selected');
        case 'onCardMove': return t('app_studio.inspector.when_card_moved', 'When a card is moved');
        case 'onChange': return t('app_studio.inspector.when_changed', 'When it changes');
        // Het slot van approval_list. De sleutel stond al in beide
        // woordenboeken en werd alleen door ActionsSection gelezen; zonder deze
        // arm zette de `default` hieronder de rauwe identifier "onDecided" in
        // een zin die een bouwer leest.
        case 'onDecided': return t('app_studio.inspector.when_decided', 'When a decision is made');
        // A slot added to NODE_EVENTS and not to this switch. The raw name is
        // wrong but it is at least the truth; silence would hide the wiring.
        default: return event;
    }
}

/** The expression behind a boolean|formula flag (legacy bare strings included). */
function exprOf(flag) {
    if (typeof flag === 'string') return flag;
    if (flag && typeof flag === 'object') return flag.expr || '';
    return '';
}

/** Cap an expression so a badge tooltip stays one readable line. */
function short(expr, max = 60) {
    const s = String(expr || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export default function nodeLogicSummary(node, definition, titleFor = null, t = EN_ONLY) {
    if (!node || typeof node !== 'object') return [];
    const marks = [];
    const actions = (definition?.actions && typeof definition.actions === 'object') ? definition.actions : {};

    // What happens when someone uses it. First, because it is the question
    // asked most often and the one the canvas was least able to answer.
    for (const event of NODE_EVENTS) {
        const actionId = node[event];
        if (!actionId || typeof actionId !== 'string') continue;
        const action = actions[actionId];
        const what = action
            ? describeAction(actionId, action, definition, titleFor)
            // A slot pointing at an action that is not there is a real break —
            // validate.js rejects it on the next save — so say so rather than
            // drawing a badge that claims something happens.
            : t('app_studio.canvas.mark_missing_action', 'points at an action that no longer exists');
        marks.push({
            key: `${event}:${actionId}`,
            kind: 'action',
            text: t('app_studio.canvas.mark_event', '{event}: {what}', { event: eventText(t, event), what }),
            // The canvas pill ("start automation · Offerte berekenen", Studio
            // artboard 1b) needs to know WHICH kind of action sits behind the
            // event, and the automation's own title when there is one. Extra
            // fields, so every reader of `text` stays untouched.
            event,
            actionId,
            actionKind: action?.kind || null,
            actionTitle: action?.kind === 'run_automation' && typeof titleFor === 'function'
                ? (titleFor(action.automationId) || null)
                : null,
        });
    }

    const visibleWhen = exprOf(node.visibleWhen);
    if (visibleWhen) {
        marks.push({
            key: 'visibleWhen',
            kind: 'visibility',
            text: t('app_studio.canvas.mark_visible_when', 'Only shown when {expr}', { expr: short(visibleWhen) }),
        });
    } else if (node.visible === false) {
        marks.push({
            key: 'visible',
            kind: 'visibility',
            text: t('app_studio.canvas.mark_hidden', 'Hidden in the running app'),
        });
    }

    const enabledWhen = exprOf(node.enabledWhen);
    if (enabledWhen) {
        marks.push({
            key: 'enabledWhen',
            kind: 'enablement',
            text: t('app_studio.canvas.mark_enabled_when', 'Only usable when {expr}', { expr: short(enabledWhen) }),
        });
    }

    const rules = Array.isArray(node.validations) ? node.validations.filter(Boolean) : [];
    if (rules.length) {
        marks.push({
            key: 'validations',
            kind: 'validation',
            // The ternary goes around the KEY, never around a piece of the
            // sentence — English grammar baked into JavaScript is the one
            // plural shape no translation can do anything with.
            text: rules.length === 1
                ? t('app_studio.canvas.mark_validations', 'Checks {n} rule before submitting', { n: rules.length })
                : t('app_studio.canvas.mark_validations_plural', 'Checks {n} rules before submitting', { n: rules.length }),
        });
    }

    const computed = (node.computed && typeof node.computed === 'object') ? Object.keys(node.computed) : [];
    if (computed.length) {
        marks.push({
            key: 'computed',
            kind: 'computed',
            text: t('app_studio.canvas.mark_computed', 'Works out {list} while the app runs', { list: computed.join(', ') }),
        });
    }

    return marks;
}

/**
 * Does this node, or anything inside it, carry logic?
 *
 * A container's own badge would otherwise say "plain" while every button in it
 * has an action — and a collapsed or scrolled-away child is exactly the one
 * somebody loses track of.
 */
export function subtreeHasLogic(node, definition) {
    if (!node) return false;
    if (nodeLogicSummary(node, definition).length) return true;
    return (Array.isArray(node.children) ? node.children : [])
        .some((child) => subtreeHasLogic(child, definition));
}

/**
 * How many pieces of logic an app carries, over every screen: every event slot
 * that points at an action, on every node of every screen (containers
 * included). Rules that only shape a component (visibility, validation,
 * computed) are not "logic you wired", so they do not count.
 *
 * NIET LANGER de badge van het "Logic n"-segment. Dat getal komt sinds de
 * Logica-tab uit `editor/logicRows.countWiredLogic`, dat dezelfde rijen telt
 * als de tabel eronder — inclusief de zes actie-oppervlakken die deze functie
 * niet kent. Twee tellers voor hetzelfde segment is precies de drift die dat
 * getal onbetrouwbaar maakte; wat hier overblijft is de eventtelling, en die
 * heet ook zo.
 */
export function countLogicMarks(definition) {
    let n = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        n += nodeLogicSummary(node, definition).filter((m) => m.kind === 'action').length;
        for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
    };
    for (const screen of Array.isArray(definition?.screens) ? definition.screens : []) {
        for (const section of Array.isArray(screen?.sections) ? screen.sections : []) {
            for (const child of Array.isArray(section?.children) ? section.children : []) walk(child);
        }
    }
    return n;
}

/**
 * Every logic mark in the app with the screen and component it sits on.
 * → [{ screenId, screenName, nodeId, nodeType, mark }]
 *
 * Was de bron van de Logica-weergave; die rol is naar editor/logicRows.js
 * gegaan, dat óók de onbedrade slots en de zes actie-oppervlakken telt. Wat
 * hier staat is de gelokaliseerde variant van nodeLogicSummary — dezelfde
 * marks, met scherm en component erbij — en het blijft de vorm die een lezer
 * wil die alleen de BEDRADE logica hoeft te weten.
 */
export function collectLogicMarks(definition, titleFor = null, t = EN_ONLY) {
    const rows = [];
    const walk = (node, screen) => {
        if (!node || typeof node !== 'object') return;
        for (const mark of nodeLogicSummary(node, definition, titleFor, t)) {
            rows.push({ screenId: screen.id, screenName: screen.name || '', nodeId: node.id, nodeType: node.type, mark });
        }
        for (const child of Array.isArray(node.children) ? node.children : []) walk(child, screen);
    };
    for (const screen of Array.isArray(definition?.screens) ? definition.screens : []) {
        for (const section of Array.isArray(screen?.sections) ? screen.sections : []) {
            for (const child of Array.isArray(section?.children) ? section.children : []) walk(child, screen);
        }
    }
    return rows;
}
