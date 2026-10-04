/**
 * nodeTypeColors — the ONE place that turns a step's visual family and its
 * run status into colours, tile shapes and card chrome for the automations
 * canvas (Bee Flow Builder redesign, Sep 2026).
 *
 * Before this module, colour lived in every node component separately: each
 * `flow/nodes/*.jsx` picked its own icon tint, `StepNodeBase` held a ladder of
 * Tailwind classes (`border-emerald-500 ring-1 …`) per run status, the minimap
 * had its own hexes, and the edge palette was a third vocabulary. Nothing
 * checked that they agreed, and a step type that forgot to pick a colour simply
 * rendered grey. This is the sixth per-type map in the builder — and, like
 * nodeDefs.js before it, it ships with a completeness test so a new step type
 * cannot arrive colourless.
 *
 * Contract:
 *   - A LEAF module. It imports `stepFamily` from nodeDefs.js and nothing else
 *     from flow/, so nodeDefs, stepPalette, the node components, the minimap and
 *     the legend can all read it without a cycle. Its one import from outside
 *     flow/ is the shared status table (components/shared/statusTokens.ts),
 *     which is a leaf itself — see STATUS_VAR for why it is worth the edge.
 *   - Emits CSS custom properties only (`var(--type-ai)`, `var(--success)`),
 *     never a hex — src/index.css owns the values, per theme.
 *   - Status ALWAYS beats type. A card's border and ring carry the run status;
 *     the family colour is confined to the 4px bar and the icon tile. That is
 *     what lets a running or failed step read at a glance regardless of what
 *     kind of step it is.
 *   - `--accent` is never used here. It defaults to a grey (#9ca3af) that
 *     vanished against light themes when it carried a running node's border.
 */
import { stepFamily, NODE_FAMILIES } from './nodeDefs';
import { tokenFor } from '../../../shared/statusTokens';

export const TYPE_GROUPS = NODE_FAMILIES;

/**
 * The visual family of a step (or a bare type string). Takes the whole step
 * so a later rule that depends on more than the type — a guard's mode, a
 * form page's `mode: 'ending'` — has somewhere to live without every caller
 * changing signature.
 */
export function typeGroupOf(stepOrType) {
    if (!stepOrType) return null;
    const type = typeof stepOrType === 'string' ? stepOrType : stepOrType.type;
    return stepFamily(type);
}

/** `var(--type-ai)` for a family; a neutral ink when there is none. */
export function typeColorVar(group) {
    return group && NODE_FAMILIES.includes(group) ? `var(--type-${group})` : 'var(--text-tertiary)';
}

/**
 * A tint of the family colour for fills: the icon tile (18%), a selected
 * source row (18%), a hover wash (8%). `color-mix` so it follows the theme's
 * own value at paint time.
 */
export function typeTint(group, pct = 18) {
    return `color-mix(in srgb, ${typeColorVar(group)} ${pct}%, transparent)`;
}

/**
 * Every status word a step row on this canvas can carry: the runner's own
 * vocabulary, its `awaiting_confirm` spelling, plus `pinned` — the stub
 * runStatus.js invents for a step whose output was frozen. Listed so a new
 * status cannot fall through to "looks idle" by accident; the test asserts
 * this set against what the canvas actually receives.
 */
const CANVAS_STATUSES = Object.freeze([
    'success', 'error', 'running', 'handled_error',
    'awaiting_approval', 'awaiting_confirm', 'awaiting_form',
    'paused', 'pinned', 'queued', 'skipped', 'cancelled',
]);

/**
 * Run status → the CSS variable that paints a card's border, its ring, its
 * pulse and its minimap swatch. `null` = no status chrome; the card keeps its
 * neutral border, which is what a state that makes no claim looks like here.
 *
 * The VALUES are not decided here. They come from the shared status table
 * (components/shared/statusTokens.ts), the same table the run panel, the
 * inspector's Run tab and the studio's status dots read. This canvas is why
 * that matters: it used to spell the ladder out itself and painted `running`
 * in --warning — the SAME amber as `paused`, which is the CW-04 defect in
 * full — so the run panel drew a step blue while the card next to it, in the
 * same view, drew it amber. A colour decided in two places drifts; this one
 * is decided once.
 *
 * `tokenFor` resolves the server's own spellings on the way through
 * (`awaiting_confirm` → awaiting_approval, `failed` → error) and degrades a
 * word it has never heard of to the neutral `idle` row, so a status from a
 * future runner paints no chrome instead of painting nonsense.
 */
export function statusVar(status) {
    return status ? tokenFor(status).cssVar : null;
}

export const STATUS_VAR = Object.freeze(
    Object.fromEntries(CANVAS_STATUSES.map(s => [s, statusVar(s)])),
);

/**
 * The short word on a status badge (i18n key + English).
 *
 * Only statuses that paint chrome get one: the badge is a solid chip in the
 * status colour, so a status without a colour has nothing to sit on. `paused`
 * had an entry while it was amber; it is neutral now (statusTokens: as quiet
 * as `queued`, because neither is a problem and neither is a warning), and on
 * this canvas a neutral status is a card with no badge — exactly like
 * `queued` and `cancelled` already were.
 */
export const STATUS_BADGE = Object.freeze({
    running: { key: 'automations.card.badge_running', en: 'running' },
    success: { key: 'automations.card.badge_done', en: 'done' },
    error: { key: 'automations.card.badge_failed', en: 'failed' },
    handled_error: { key: 'automations.card.badge_recovered', en: 'recovered' },
    awaiting_approval: { key: 'automations.card.badge_waiting', en: 'waiting' },
    awaiting_confirm: { key: 'automations.card.badge_waiting', en: 'waiting' },
    awaiting_form: { key: 'automations.card.badge_waiting', en: 'waiting' },
    pinned: { key: 'automations.card.badge_pinned', en: 'pinned' },
});

/** Card geometry from the design: 240×72, layout box 240×96 with the tool port. */
export const CARD_W = 240;
export const CARD_H = 72;

/**
 * A card with MORE than two output ports grows so every port and its label
 * get a row of their own (user feedback 2026-09-03: a four-way condition
 * crammed "zelf · zoeken · strategie · otherwise" onto 72px). Two ports —
 * then / else — still fit the standard card. The layout reads the same
 * number (aiToolNodes.toolLayoutHeights), so a taller card gets its room in
 * dagre and in the rows.
 */
export const PORT_PITCH = 22;
export const PORT_PAD = 10;
export function cardHeightForPorts(portCount) {
    const n = Number(portCount) || 0;
    if (n <= 2) return CARD_H;
    return Math.max(CARD_H, n * PORT_PITCH + 2 * PORT_PAD);
}

/**
 * Corner radius per family — a trigger is rounded on its leading edge, an
 * end card on its trailing edge, everything else is `--radius-md`.
 */
export function cardRadius(group) {
    if (group === 'trigger') return '36px var(--radius-md) var(--radius-md) 36px';
    if (group === 'end') return 'var(--radius-md) 36px 36px var(--radius-md)';
    return 'var(--radius-md)';
}

/**
 * The 34px icon tile. Shape encodes the family a second time, for anyone who
 * cannot rely on colour: a form is a circle, a Privacy Shield a shield, a
 * branch a 45° diamond, an end card a solid ink block. Returns `{ tile, glyph }`
 * inline-style objects; the glyph gets the counter-rotation a diamond needs.
 */
export function typeTileStyle(group, { type = null, error = false } = {}) {
    const color = error ? 'var(--error)' : typeColorVar(group);
    const tile = {
        width: 34, height: 34, flexShrink: 0,
        borderRadius: 9,
        display: 'grid', placeItems: 'center',
        background: error ? 'color-mix(in srgb, var(--error) 18%, transparent)' : typeTint(group),
        color,
    };
    const glyph = { width: 16, height: 16, display: 'inline-flex' };
    if (type === 'form_page') tile.borderRadius = 999;
    if (group === 'guard') tile.borderRadius = '8px 8px 50% 50%';
    if (group === 'branch') {
        tile.transform = 'rotate(45deg) scale(.85)';
        tile.borderRadius = 7;
        glyph.transform = 'rotate(-45deg)';
        glyph.display = 'inline-block';
    }
    if (group === 'end') {
        tile.background = error ? 'var(--error)' : 'var(--text-primary)';
        tile.color = error ? '#fff' : 'var(--bg-primary)';
    }
    return { tile, glyph };
}

/**
 * Everything about a card's outline in one place, so the card, the minimap
 * and the legend cannot disagree. Precedence, highest first:
 *   selected → run status → pinned → disabled/dashed-loop → neutral.
 *
 * Returns `{ style, badge }`:
 *   style — border, boxShadow (the 4px family bar + shadow + status ring),
 *           outline/animation for `running`, opacity for disabled, radius.
 *   badge — `{ key, en, bg, fg }` or null.
 */
export function cardChrome({ group, type = null, status = null, pinned = false, disabled = false, selected = false, error = false } = {}) {
    const bar = error ? 'var(--error)' : typeColorVar(group);
    const parts = [`inset 4px 0 0 ${bar}`, 'var(--shadow-sm)'];
    let border = '1px solid var(--border-default)';
    let opacity = 1;
    let outline = null;
    let animation = null;
    let badge = null;

    if (group === 'loop' && type !== 'loop_item') border = `1.5px dashed ${typeColorVar('loop')}`;

    const effective = status || (pinned ? 'pinned' : null);
    // Through statusVar, so an unknown word (and `constructor`, which is a
    // function on every object literal) yields null rather than a border
    // painted with something that is not a colour.
    const sc = statusVar(effective);
    if (sc) {
        border = `1.5px solid ${sc}`;
        parts.push(`0 0 0 4px color-mix(in srgb, ${sc} 22%, transparent)`);
        const b = STATUS_BADGE[effective];
        if (b) badge = { key: b.key, en: b.en, bg: sc, fg: '#fff' };
        // The pulse lives inside this branch on purpose: it is the status
        // colour breathing, so a status without a colour cannot have one.
        if (effective === 'running') {
            outline = `3px solid ${sc}`;
            animation = 'bf-node-pulse 1.4s ease-in-out infinite';
        }
    }
    if (effective === 'skipped') { border = '1px dashed var(--border-default)'; opacity = 0.7; }
    if (disabled) { border = '1px dashed var(--text-tertiary)'; opacity = 0.55; }
    if (selected) {
        border = '2px solid var(--text-primary)';
        parts.push('0 0 0 4px color-mix(in srgb, var(--text-primary) 14%, transparent)');
    }

    const style = {
        borderRadius: cardRadius(group),
        border,
        boxShadow: parts.join(', '),
        opacity,
    };
    if (outline) {
        style.outline = outline;
        style.outlineOffset = 3;
        style.animation = animation;
        // The keyframe animates outline-color, so it OVERRIDES the colour in
        // the shorthand above. It reads --bf-pulse-color (index.css), which
        // gets the very token the border uses — without this the pulse would
        // be whatever colour the stylesheet happened to name, on a card whose
        // static outline says something else.
        style['--bf-pulse-color'] = sc;
    }
    return { style, badge };
}

/**
 * The minimap swatch for a step: its status colour when it has one, otherwise
 * its family colour.
 */
export function miniMapColor(group, status = null) {
    return statusVar(status) || typeColorVar(group);
}
