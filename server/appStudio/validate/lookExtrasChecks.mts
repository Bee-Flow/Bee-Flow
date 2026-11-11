/**
 * App Studio validator — the vocabulary of packages LK20 and LK21b (schema 3) that the generic
 * prop checks cannot judge on their own:
 *
 *   columns[].template   a table or data_grid column with `format: 'template'` writes a formula
 *                        per row: it must be there and compile.
 *   gauge min / max      a gauge draws in min..max: max must be above min.
 *   wizard steps         child i is the body of step i: as many children as steps.
 *   node.tooltip         plain text of at most 200 characters.
 *
 * One walk over every node of every screen. A definition without this vocabulary gets no
 * finding from here.
 */

import { compile } from '../../shared/expr/engine.mjs';
import { createRequire } from 'node:module';
import type { Finding } from '../definitionKeyRegistry.mts';

const { MAX_TOOLTIP_LEN } = createRequire(import.meta.url)('../componentSpecs/tooltipKey.js') as { MAX_TOOLTIP_LEN: number };

type Bag = Record<string, unknown>;
type PushFinding = (finding: Finding) => void;
export interface LookPush { pushE: PushFinding; pushW: PushFinding }
type NodeCheck = (node: Bag, props: Bag, path: string, push: LookPush) => void;

const isObject = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Does `expr` compile as a formula? */
function compiles(expr: string): boolean {
    try {
        compile(expr);
        return true;
    } catch {
        return false;
    }
}

/** A template column must say what it writes, in a formula that compiles. */
function checkColumnTemplates(node: Bag, props: Bag, path: string, { pushE, pushW }: LookPush): void {
    if (node.type !== 'table' && node.type !== 'data_grid') return;
    const columns = Array.isArray(props.columns) ? props.columns : [];
    columns.forEach((col, i) => {
        if (!isObject(col) || col.format !== 'template') return;
        const at = `${path}.props.columns[${i}].template`;
        const expr = typeof col.template === 'string' ? col.template.trim() : '';
        if (!expr) {
            pushW({ code: 'column.template_missing', severity: 'warning', path: at, message: 'A column with format "template" has no template, so every cell shows a dash.', hint: 'Set template to a formula, e.g. item.first + " " + item.last.' });
        } else if (!compiles(expr)) {
            pushE({ code: 'column.template_invalid', severity: 'error', path: at, message: `The column template ${JSON.stringify(expr.slice(0, 80))} is not a valid formula.`, hint: 'Write a formula with item for the row, e.g. concat(item.city, ", ", item.country).' });
        }
    });
}

/** A gauge needs a range to draw in: max above min. */
function checkGaugeRange(node: Bag, props: Bag, path: string, { pushW }: LookPush): void {
    if (node.type !== 'gauge') return;
    const min = typeof props.min === 'number' ? props.min : 0;
    const max = typeof props.max === 'number' ? props.max : 100;
    if (max > min) return;
    pushW({ code: 'gauge.range_invalid', severity: 'warning', path: `${path}.props.max`, message: `The gauge's max (${max}) is not above its min (${min}), so its arc stays empty.`, hint: 'Set max above min.' });
}

/** A wizard shows child i as step i: a step without a body, or a body without a step, cannot be reached as meant. */
function checkWizardSteps(node: Bag, props: Bag, path: string, { pushW }: LookPush): void {
    if (node.type !== 'wizard') return;
    const steps = Array.isArray(props.steps) ? props.steps.length : 0;
    const bodies = Array.isArray(node.children) ? node.children.length : 0;
    if (steps === bodies) return;
    pushW({ code: 'wizard.steps_mismatch', severity: 'warning', path: `${path}.props.steps`, message: `The wizard has ${steps} step(s) and ${bodies} child(ren); child number i is the body of step number i.`, hint: 'Give every step one child (usually a container), in the same order.' });
}

/** A tooltip is plain text of at most MAX_TOOLTIP_LEN characters (componentSpecs/tooltipKey.js). */
function checkTooltip(node: Bag, _props: Bag, path: string, { pushE }: LookPush): void {
    if (node.tooltip === undefined) return;
    if (typeof node.tooltip === 'string' && node.tooltip.trim() && node.tooltip.length <= MAX_TOOLTIP_LEN) return;
    pushE({ code: 'node.tooltip_invalid', severity: 'error', path: `${path}.tooltip`, message: `tooltip must be a non-empty text of at most ${MAX_TOOLTIP_LEN} characters.`, hint: 'Write a short plain sentence, or leave tooltip out.' });
}

/** The checks per node, in the order their findings appear. */
const NODE_CHECKS: readonly NodeCheck[] = [checkColumnTemplates, checkGaugeRange, checkWizardSteps, checkTooltip];

function walkNode(node: unknown, path: string, push: LookPush): void {
    if (!isObject(node)) return;
    const props = isObject(node.props) ? node.props : {};
    for (const check of NODE_CHECKS) check(node, props, path, push);
    if (Array.isArray(node.children)) node.children.forEach((child, i) => walkNode(child, `${path}.children[${i}]`, push));
}

/** Every finding of this module for `def`. */
export function checkLookExtras(def: unknown, push: LookPush): void {
    const screens = isObject(def) && Array.isArray(def.screens) ? def.screens : [];
    screens.forEach((screen, si) => {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        sections.forEach((section, ci) => {
            const nodes = isObject(section) && Array.isArray(section.children) ? section.children : [];
            nodes.forEach((node, ni) => walkNode(node, `screens[${si}].sections[${ci}].children[${ni}]`, push));
        });
    });
}
