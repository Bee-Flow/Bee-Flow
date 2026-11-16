/**
 * App Studio validator: layouts that run but read as chaos. Every finding is a warning, and only
 * the AI builder asks for them (validateAppDefinition opts.layoutHygiene: after each change and in
 * app_finalize's result); a save or a publish does not, so no stored app gains a finding.
 *
 *   layout.css_overrides_grid       design.customCss places a component cell or a section itself
 *                                   (grid-column, grid-row, grid-area, display, position: absolute)
 *                                   and so fights the 12-column grid the spans describe
 *   layout.empty_container          a card or container with no children: an empty box on screen
 *   layout.several_primary_actions  two or more primary buttons among the children of one card,
 *                                   container, form, modal or page header (a keypad or a toolbar
 *                                   of five or more buttons is left alone)
 *
 * Built after a builder, asked to make a screen "more logical", wrote grid-column and absolute
 * positioning into the stylesheet instead of regrouping the components (2026-11-16).
 */

import type { Finding } from '../definitionKeyRegistry.mts';

type PushFinding = (finding: Finding) => void;
type Bag = Record<string, unknown>;

const isObject = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Grid placement properties: on a cell they move it out of the place its span gives it. */
const GRID_PLACEMENT = new Set(['grid-column', 'grid-column-start', 'grid-column-end', 'grid-row', 'grid-row-start', 'grid-row-end', 'grid-area', 'display']);
/** Selector pieces that address a component cell or a section (appDesignSpec.js customCss). */
const CELL_SELECTORS = ['.u-', '[data-node-id', '[data-section-id'];
/**
 * The boxes whose children are one group of actions. A section is not one: it holds several
 * groups side by side (a list with its own button, another list with its own).
 */
const ACTION_GROUP_TYPES = new Set(['card', 'container', 'form', 'modal', 'page_header']);
/** A group with more buttons than this is a keypad or a toolbar, not one decision. */
const MAX_ACTION_GROUP = 4;
/** Enough to show the pattern; the rest of the stylesheet is the same kind of fix. */
const MAX_CSS_FINDINGS = 3;

export interface CssRule { selector: string; body: string }

/**
 * The style rules of a stylesheet, nested inside at-rules or not: every block that holds no
 * block of its own and whose prelude is not an at-rule. Comments are already gone (appCss.mts).
 */
export function styleRules(css: string): CssRule[] {
    const out: CssRule[] = [];
    const stack: { prelude: string; bodyStart: number; parent: boolean }[] = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            const top = stack[stack.length - 1];
            if (top) top.parent = true;
            stack.push({ prelude: css.slice(start, i).trim(), bodyStart: i + 1, parent: false });
            start = i + 1;
        } else if (ch === '}') {
            const frame = stack.pop();
            if (frame && !frame.parent && frame.prelude && !frame.prelude.startsWith('@')) {
                out.push({ selector: frame.prelude, body: css.slice(frame.bodyStart, i) });
            }
            start = i + 1;
        } else if (ch === ';') {
            start = i + 1;
        }
    }
    return out;
}

/** The last compound of one selector: the element it actually styles. */
function lastCompound(selector: string): string {
    let depth = 0;
    let cut = 0;
    for (let i = 0; i < selector.length; i++) {
        const ch = selector[i];
        if (ch === '[' || ch === '(') depth += 1;
        else if (ch === ']' || ch === ')') depth -= 1;
        else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === '\n' || ch === '\t')) cut = i + 1;
    }
    return selector.slice(cut);
}

/** Does one selector of the list style a component cell or a section (not a part inside one)? */
function targetsCell(selectorList: string): boolean {
    return selectorList.split(',').some((one) => {
        const last = lastCompound(one.trim());
        return !last.includes('.bfa-') && CELL_SELECTORS.some((piece) => last.includes(piece));
    });
}

/** The placement declarations of a rule body, as `property` names (position only when absolute). */
function placementProps(body: string): string[] {
    const found: string[] = [];
    for (const decl of body.split(';')) {
        const colon = decl.indexOf(':');
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const value = decl.slice(colon + 1).trim().toLowerCase();
        if (GRID_PLACEMENT.has(prop) || (prop === 'position' && value.startsWith('absolute'))) {
            const name = prop === 'position' ? 'position: absolute' : prop;
            if (!found.includes(name)) found.push(name);
        }
    }
    return found;
}

function checkStylesheet(def: Bag, pushW: PushFinding): void {
    const design = isObject(def.design) ? def.design : null;
    const css = design && typeof design.customCss === 'string' ? design.customCss : '';
    if (!css) return;
    let shown = 0;
    for (const rule of styleRules(css)) {
        if (shown >= MAX_CSS_FINDINGS) break;
        if (!targetsCell(rule.selector)) continue;
        const props = placementProps(rule.body);
        if (!props.length) continue;
        shown += 1;
        pushW({
            code: 'layout.css_overrides_grid', severity: 'warning', path: 'design.customCss',
            message: `The stylesheet rule "${rule.selector.slice(0, 80)}" sets ${props.join(', ')} on a component cell or section, which overrides the 12-column grid the spans describe.`,
            hint: 'Lay the screen out with sections, spans and containers (app_move_node, app_wrap_nodes, style.span) and remove the placement from the stylesheet with app_set_theme customCssEdits.',
        });
    }
}

const isPrimaryButton = (n: Bag): boolean => n.type === 'button' && (!isObject(n.props) || n.props.variant === undefined || n.props.variant === null || n.props.variant === 'primary');

function checkGroup(children: unknown[], path: string, pushW: PushFinding): void {
    const buttons = children.filter((c): c is Bag => isObject(c) && c.type === 'button');
    const primaries = buttons.filter(isPrimaryButton);
    if (primaries.length >= 2 && buttons.length <= MAX_ACTION_GROUP) {
        pushW({
            code: 'layout.several_primary_actions', severity: 'warning', path,
            message: `${primaries.length} primary buttons sit side by side here (${primaries.map((b) => String(b.id)).join(', ')}): the reader cannot tell which one is the main action.`,
            hint: 'Keep one primary button per group and give the others variant secondary, outline or ghost.',
        });
    }
}

function walkNodes(children: unknown, path: string, pushW: PushFinding, group: boolean): void {
    if (!Array.isArray(children)) return;
    if (group) checkGroup(children, path, pushW);
    children.forEach((node, i) => {
        if (!isObject(node)) return;
        const at = `${path}[${i}]`;
        if ((node.type === 'card' || node.type === 'container') && Array.isArray(node.children) && !node.children.length) {
            pushW({
                code: 'layout.empty_container', severity: 'warning', path: at,
                message: `${String(node.id)} is an empty ${String(node.type)}: it shows as an empty box.`,
                hint: 'Move the components it should group into it (app_move_node), or remove it (app_remove_node).',
            });
        }
        walkNodes(node.children, `${at}.children`, pushW, ACTION_GROUP_TYPES.has(String(node.type)));
    });
}

/** Warn about the stylesheet placement, empty boxes and competing primary actions of `def`. */
export function checkLayoutHygiene(def: unknown, pushW: PushFinding): void {
    if (!isObject(def)) return;
    checkStylesheet(def, pushW);
    const screens = Array.isArray(def.screens) ? def.screens : [];
    screens.forEach((screen, si) => {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        sections.forEach((section, ci) => {
            if (isObject(section)) walkNodes(section.children, `screens[${si}].sections[${ci}].children`, pushW, false);
        });
    });
}
