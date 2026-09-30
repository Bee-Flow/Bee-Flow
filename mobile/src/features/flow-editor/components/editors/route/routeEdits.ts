/**
 * The Condition node's edits — the web's RouteFields handlers
 * (agent-hub `Builder/flow/settings/routeEditors.jsx`), pure: each takes the
 * unified route (model/route/routeModel) and answers the patch to merge into
 * it. writeRoute then decides the runtime shape (condition / switch / filter)
 * and the draft-store write heals the node's connections
 * (mergeStepPatchIntoDefinition), so no edit here ever strands an edge.
 *
 * The number of OUTPUTS is an up-front choice (BFSF-356): one output filters,
 * several route. Fan-out ('all') is switched on only where a node crosses
 * from one output to several — a stored router keeps its first-match rule
 * until someone changes it under Advanced.
 */

import { uniqueRuleName, type Route, type RouteRule } from '@/features/flow-editor/model';

export type RoutePatch = Partial<Route>;

const rulesOf = (route: Partial<Route>): RouteRule[] => (Array.isArray(route.rules) ? route.rules : []);

/** "Output A" … "Output Z", then "Output 27". */
export function outputLetter(i: number): string {
    return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

export function addRule(route: Partial<Route>): RoutePatch {
    const rules = rulesOf(route);
    return {
        rules: [...rules, { name: uniqueRuleName(rules, `rule${rules.length + 1}`), expr: '', value: '' }],
        ...(rules.length <= 1 ? { matchMode: 'all' as const } : null),
    };
}

/** A rename carries the "when nothing matches" pick with it. */
export function updateRule(route: Partial<Route>, i: number, patch: Partial<RouteRule>): RoutePatch {
    const rules = rulesOf(route);
    return {
        rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
        ...(patch.name && route.defaultBranch === rules[i]?.name ? { defaultBranch: patch.name } : null),
    };
}

export function removeRule(route: Partial<Route>, i: number): RoutePatch {
    const rules = rulesOf(route);
    return {
        rules: rules.filter((_, j) => j !== i),
        ...(route.defaultBranch === rules[i]?.name ? { defaultBranch: '' } : null),
    };
}

/**
 * Accept "Suggest outputs": the suggested rules replace the outputs (the
 * chooser above is pre-filled by their count), the old "when nothing
 * matches" pick goes with the old names, and a node crossing from one output
 * to several fans out — addRule's rule, for addRule's reason.
 */
export function applySuggestion(route: Partial<Route>, suggested: readonly { name: string; expr: string }[]): RoutePatch {
    const named: RouteRule[] = [];
    for (const r of suggested) named.push({ name: uniqueRuleName(named, r.name), expr: r.expr, value: '' });
    return {
        rules: named,
        style: 'rules',
        defaultBranch: '',
        ...(rulesOf(route).length <= 1 && named.length > 1 ? { matchMode: 'all' as const } : null),
    };
}

/** "Several outputs" lands on several — grown to two in one step, and fanning out. */
export function chooseSeveral(route: Partial<Route>): RoutePatch | null {
    const rules = rulesOf(route);
    if (rules.length > 1) return null;
    const grown = [...rules];
    while (grown.length < 2) grown.push({ name: uniqueRuleName(grown, `rule${grown.length + 1}`), expr: '', value: '' });
    return { rules: grown, matchMode: 'all' };
}

export function collapseToOne(route: Partial<Route>): RoutePatch {
    return { rules: rulesOf(route).slice(0, 1), defaultBranch: '', matchMode: 'first' };
}

/** The outputs collapsing to one would cost a canvas connection: "Output B (invoices)". */
export function losingOutputs(route: Partial<Route>, wired: ReadonlySet<string>): { letter: string; name: string }[] {
    return rulesOf(route)
        .map((r, i) => ({ r, i }))
        .slice(1)
        .filter(({ r }) => !!r?.name && wired.has(r.name))
        .map(({ r, i }) => ({ letter: outputLetter(i), name: r.name }));
}

/** A legacy value-matching switch as full conditions — lossless: `<value> == "<case value>"`. */
export function convertToConditions(route: Partial<Route>): RoutePatch {
    return {
        style: 'rules',
        rules: rulesOf(route).map((r) => ({
            ...r,
            expr: r.expr || `${route.matchOn || 'value'} == ${typeof r.value === 'string' ? JSON.stringify(r.value) : String(r.value)}`,
        })),
    };
}

/** The names of this node's outputs that are wired on the canvas (its outgoing case edges). */
export function wiredCaseNames(edges: readonly { from?: string; label?: string | null; caseName?: string | null }[] | null | undefined, stepId: unknown): Set<string> {
    const out = new Set<string>();
    for (const e of edges || []) {
        if (!e || e.from !== stepId) continue;
        const name = e.caseName ?? (typeof e.label === 'string' && e.label.startsWith('case:') ? e.label.slice(5) : null);
        if (name) out.add(name);
    }
    return out;
}

/** A case name as committed: trimmed, present, not a sibling's — or why not. */
export function checkCaseName(text: string, current: string, siblings: readonly string[]): { name: string } | { error: 'required' | 'taken'; name: string } {
    const trimmed = String(text || '').trim();
    if (trimmed === current) return { name: current };
    if (!trimmed) return { error: 'required', name: current };
    if (siblings.includes(trimmed)) return { error: 'taken', name: trimmed };
    return { name: trimmed };
}
