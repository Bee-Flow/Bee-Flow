/**
 * App Studio validator — the vocabulary of packages LK20 and LK21b (schema 3) that the generic
 * prop checks cannot judge on their own:
 *
 *   columns[].template   a table or data_grid column with `format: 'template'` writes a formula
 *                        per row: it must be there and compile.
 *
 * One walk over every node of every screen. A definition without this vocabulary gets no
 * finding from here.
 */

import { compile } from '../../shared/expr/engine.mjs';
import type { Finding } from '../definitionKeyRegistry.mts';

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

/** The checks per node, in the order their findings appear. */
const NODE_CHECKS: readonly NodeCheck[] = [checkColumnTemplates];

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
