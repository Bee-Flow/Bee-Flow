import { nodeTypeLabel } from './nodeDefs';
import { typeGroupOf } from './nodeTypeColors';
import { nativeHomeOrigin } from './ribbon/ribbonCategories';
import { AI_STEP, buildStepGroups, orderedAppCategories } from './stepPalette';
import { resolveIntegrationFromTool } from '../../../../utils/integrationIcons';

/**
 * Where on the ribbon a card "comes from" — the pure half of the ribbon
 * flight (the stateful half is useRibbonFlight.js, the ghost itself
 * RibbonFlightLayer.jsx).
 *
 * While the AI builds, every card it adds is dealt from the ribbon: the
 * command that would have added it by hand gets a ring, and a ghost of the
 * card flies from that command to the slot on the canvas. This module answers
 * two questions with no DOM of its own: WHICH command (`originKeysFor`, a
 * list of `data-ribbon-origin` keys from most to least specific) and WHAT the
 * ghost shows (`flightGlyphFor`). `resolveOrigin` is the one DOM touch —
 * given the ribbon root and the keys, the first stamped element that is
 * really on screen.
 *
 * The keys are a ladder on purpose. The Apps tab folds a category's overflow
 * behind one "more" command, collapses a whole category into one pill when
 * the row is too narrow (flow/appsRibbonLayout.js — which of the two happens
 * depends on the width of the window, so nothing here can know), the Home
 * tab shows a section as a pill but the Apps tab does not, and a scope
 * without apps has no Apps tab at all — so a step's ideal origin is often
 * not rendered, and the flight then departs from the next best thing (the
 * tab strip, then the ribbon as a whole) rather than not at all.
 */

/** The AI step has no palette section: it is the ribbon's one inline command. */
const AI_SECTION_KEY = 'ai';

/**
 * Runtime types the palette does not list under their own name. The Condition
 * node is one palette item for three runtime shapes (flow/routeModel.js);
 * Parse JSON was absorbed by Edit data.
 */
const KIND_ALIASES = Object.freeze({ switch: 'condition', filter: 'condition', parse_json: 'set' });

let paletteIndexCache = null;

/**
 * kind → { section, icon } from the SAME `buildStepGroups` the ribbon renders,
 * built once: the palette is module data, and asking it per card would rebuild
 * every group per departure. Code is included regardless of the catalog flag
 * so a `code` step still finds its Integrations section; a scope that hides
 * the command simply has no pill for the key to resolve to, and the ladder
 * falls through.
 */
function paletteIndex() {
    if (paletteIndexCache) return paletteIndexCache;
    const bySection = new Map();
    const iconByKind = new Map();
    const groups = buildStepGroups({ mode: 'step', catalog: { flags: { code: true } }, canCreateLayer: false });
    const flow = groups.find(g => g.key === 'flow');
    for (const sec of flow?.sections || []) {
        for (const it of sec.items || []) {
            const kind = it?.payload?.kind;
            if (!kind) continue;
            if (!bySection.has(kind)) bySection.set(kind, sec.key);
            if (it.icon && !iconByKind.has(kind)) iconByKind.set(kind, it.icon);
        }
    }
    bySection.set('ai_step', AI_SECTION_KEY);
    if (AI_STEP.icon) iconByKind.set('ai_step', AI_STEP.icon);
    // The AI group's other members (Extract data) depart from the same
    // command: the group has one stamped origin, and it is the AI step's.
    for (const it of groups.find(g => g.key === 'ai')?.items || []) {
        const kind = it?.payload?.kind;
        if (!kind || bySection.has(kind)) continue;
        bySection.set(kind, AI_SECTION_KEY);
        if (it.icon && !iconByKind.has(kind)) iconByKind.set(kind, it.icon);
    }
    paletteIndexCache = { bySection, iconByKind };
    return paletteIndexCache;
}

/** The Home-tab section (`flow_control | people | data | integrations | ai`) a step kind lives in, or null. */
export function sectionKeyForKind(kind) {
    if (!kind) return null;
    const k = KIND_ALIASES[kind] || kind;
    return paletteIndex().bySection.get(k) ?? null;
}

/**
 * The catalog spells an integration id with dashes (`google-calendar`), the
 * tool-prefix resolver and INTEGRATION_META with underscores
 * (`google_calendar`), and a step's `appId` with whichever produced it. Every
 * spelling is tried, so a stamp written from one source is found from another.
 */
function idVariants(id) {
    if (!id) return [];
    const s = String(id);
    return [...new Set([s, s.replace(/-/g, '_'), s.replace(/_/g, '-')])];
}

function sameIntegration(a, b) {
    return !!a && !!b && String(a).replace(/-/g, '_').toLowerCase() === String(b).replace(/-/g, '_').toLowerCase();
}

/** The Apps-tab category an integration sits in, or null when the catalog does not list it. */
function categoryOf(integrationId, catalog) {
    if (!integrationId) return null;
    for (const { category, apps } of orderedAppCategories(catalog)) {
        if (apps.some(app => sameIntegration(app.integrationId, integrationId) || sameIntegration(app.id, integrationId))) return category;
    }
    return null;
}

function integrationIdOf(step) {
    return step?.appId || resolveIntegrationFromTool(step?.tool) || null;
}

/**
 * The `data-ribbon-origin` keys to try for a step, most specific first. A
 * trigger has no origin: the ribbon offers triggers behind a dropdown nobody
 * sees during a build, and the trigger's arrival is the canvas mounting.
 *
 * An app's own command comes first; when the ribbon has folded it behind its
 * category's "n more" or collapsed the whole category into a pill, that
 * command is not on screen and the ladder lands on the fold or the pill
 * instead — both are offered whenever the catalog knows the category, and
 * `resolveOrigin` takes the first one that is really rendered. A Bee Flow
 * tool (web search, memory, knowledge base, ...) lives on the tab of its job,
 * not in an app category, so its ladder goes to that tab's stamp instead.
 */
export function originKeysFor(step, catalog = null) {
    const type = step?.type;
    if (!type || type === 'trigger') return [];
    if (type === 'integration_action') {
        const id = integrationIdOf(step);
        const keys = idVariants(id).map(v => `app:${v}`);
        const home = nativeHomeOrigin(id);
        const category = home ? null : categoryOf(id, catalog);
        if (home) keys.push(home);
        if (category) keys.push(`more:${category}`, `cat:${category}`);
        return [...keys, 'tabs', 'ribbon'];
    }
    const section = sectionKeyForKind(type);
    return [...(section ? [`section:${section}`] : []), 'tabs', 'ribbon'];
}

/**
 * What the ghost card shows on its way over: the app's logo for an
 * integration action, else the palette icon of the step's kind (the same
 * lucide component the ribbon command shows), the family for the tile
 * colour, and the step's own name.
 */
export function flightGlyphFor(step) {
    const type = step?.type || null;
    const isApp = type === 'integration_action';
    const label = typeof step?.label === 'string' && step.label.trim() ? step.label.trim() : (nodeTypeLabel(type) || '');
    return {
        type,
        integrationId: isApp ? integrationIdOf(step) : null,
        tool: isApp && typeof step?.tool === 'string' ? step.tool : null,
        icon: paletteIndex().iconByKind.get(KIND_ALIASES[type] || type) || null,
        iconName: typeof step?.icon === 'string' && step.icon ? step.icon : null,
        family: typeGroupOf(type),
        label,
    };
}

function attrValue(key) {
    return String(key).replace(/["\\]/g, '\\$&');
}

function plainRect(r) {
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
}

/** Intersect `rect` with `bounds`; the rect itself when the bounds have no area (jsdom, a detached root). */
function clampRect(rect, bounds) {
    const r = plainRect(rect);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return r;
    const left = Math.max(r.left, bounds.left);
    const top = Math.max(r.top, bounds.top);
    const right = Math.min(r.right, bounds.left + bounds.width);
    const bottom = Math.min(r.bottom, bounds.top + bounds.height);
    if (right <= left || bottom <= top) return r;
    return { left, top, width: right - left, height: bottom - top, right, bottom };
}

/**
 * The first stamped element in `root` for `keys`, with its screen rect
 * clamped to the ribbon's own box — or null when none is on screen. An
 * element with no width is not on screen (a collapsed cluster, a hidden
 * breakpoint), and `checkVisibility` says so for `display: none` ancestors
 * where a rect alone would not; jsdom has neither, which is what the `?.()`
 * is for.
 */
export function resolveOrigin(root, keys) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const bounds = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    for (const key of Array.isArray(keys) ? keys : []) {
        if (key == null) continue;
        const selector = `[data-ribbon-origin="${attrValue(key)}"]`;
        // querySelector never matches the root itself, and the `ribbon` key IS the root.
        const el = (typeof root.matches === 'function' && root.matches(selector)) ? root : root.querySelector(selector);
        if (!el) continue;
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect || !(rect.width > 0)) continue;
        if (typeof el.checkVisibility === 'function' && el.checkVisibility() === false) continue;
        return { el, rect: clampRect(rect, bounds) };
    }
    return null;
}
