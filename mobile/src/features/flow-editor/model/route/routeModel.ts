/**
 * The unified "Condition" node — a port of the web builder's
 * flow/routeModel.js, pinned by route.lockstep.test.ts.
 *
 * If, Switch and Filter are ONE node to the author, described by this model:
 *   mode      'branch' (decide about the whole run) | 'items' (per list item)
 *   rules     an ordered list of named conditions; each one is an output
 *   matchMode 'first' (the first match takes it; what ABSENT means) | 'all'
 *
 * The runtime keeps its three step types (`condition`, `switch`, `filter`);
 * this is the translation layer, picking the narrowest type that expresses
 * the model. Pure.
 */

import { PORT } from '../branchEdges';
import type { FlowEdge, FlowStep, SwitchCase } from '../types';

export const ROUTE_STEP_TYPES: ReadonlySet<string> = new Set(['condition', 'switch', 'filter']);

export type RouteStyle = 'rules' | 'value';
export type MatchMode = 'first' | 'all';

export interface RouteRule {
    name: string;
    expr: string;
    value: unknown;
}

export interface Route {
    mode: 'branch' | 'items';
    style: RouteStyle;
    matchMode: MatchMode;
    /**
     * Switch shapes only (BFSF-485): a list switch with exactly one rule case is
     * "One output" whose non-matching items go to Otherwise.
     */
    keepRest?: boolean;
    /** The list worked through, in items mode. */
    source: string;
    /** The value compared against each rule, in value style. */
    matchOn: string;
    rules: RouteRule[];
    defaultBranch: string;
    maxItems: number | '';
}

/** One output port: the slot it fills (rule index or the catch-all) and its label. */
export interface RoutePort {
    slot: number | 'otherwise';
    label: string | null;
    caseName?: string;
}

type RouteStepLike = Partial<Pick<FlowStep, 'type' | 'cases'>> & Record<string, unknown>;

/** Is this step edited by the unified Condition form? */
export function isRouteStep(step: { type?: string } | null | undefined): boolean {
    return !!step && !!step.type && ROUTE_STEP_TYPES.has(step.type);
}

const isRuleCase = (c: SwitchCase | null | undefined) => !!c && typeof c.expr === 'string' && c.expr.trim().length > 0;
const isBlankCase = (c: SwitchCase | null | undefined) =>
    !!c && !isRuleCase(c) && (c.value == null || String(c.value).trim() === '');

export function emptyRule(name?: string): RouteRule {
    return { name: name || 'rule1', expr: '', value: '' };
}

/** A rule name that does not collide with its siblings (ports must be unique). */
export function uniqueRuleName(rules: readonly ({ name?: string } | null | undefined)[] | null | undefined, base?: string): string {
    const names = new Set((Array.isArray(rules) ? rules : []).map((r) => r?.name).filter(Boolean));
    const stem = base || 'rule';
    if (!names.has(stem)) return stem;
    let i = 1;
    let name = stem;
    while (names.has(name)) name = `${stem}_${++i}`;
    return name;
}

/**
 * The deciding style of a persisted switch. Persisted as `routeStyle` now
 * (BFSF-356); the derivation is the fallback for older definitions, with rule
 * cases mixed with blank ones reading as 'rules'.
 */
function readStyle(step: RouteStepLike, cases: SwitchCase[]): RouteStyle {
    if (step?.routeStyle === 'rules' || step?.routeStyle === 'value') return step.routeStyle;
    if (cases.some(isRuleCase) && cases.every((c) => isRuleCase(c) || isBlankCase(c))) return 'rules';
    return cases.length && cases.every(isRuleCase) ? 'rules' : 'value';
}

/** Anything that is not EXACTLY 'all' reads as 'first' — the compatibility contract. */
export function readMatchMode(step: { matchMode?: unknown; [key: string]: unknown } | null | undefined): MatchMode {
    return step?.matchMode === 'all' ? 'all' : 'first';
}

const maxItemsOf = (step: RouteStepLike): number | '' => (typeof step.maxItems === 'number' ? step.maxItems : '');
const str = (v: unknown): string => (typeof v === 'string' ? v : '') || '';

/** Persisted step → the unified model. */
export function readRoute(step: RouteStepLike | null | undefined): Route {
    const type = step?.type;
    if (step && type === 'filter') {
        return {
            mode: 'items', style: 'rules', matchMode: 'first',
            source: str(step.arrayRef), matchOn: '',
            rules: [{ name: 'keep', expr: str(step.expr), value: '' }],
            defaultBranch: '', maxItems: maxItemsOf(step),
        };
    }
    if (step && type === 'switch') {
        const cases = Array.isArray(step.cases) ? step.cases : [];
        const listMode = typeof step.arrayRef === 'string';
        const style = readStyle(step, cases);
        return {
            mode: listMode ? 'items' : 'branch',
            style,
            keepRest: listMode && style === 'rules' && cases.length === 1,
            matchMode: readMatchMode(step),
            source: str(step.arrayRef),
            matchOn: str(step.expr),
            rules: cases.map((c) => ({ name: c?.name || '', expr: c?.expr || '', value: c?.value ?? '' })),
            defaultBranch: str(step.defaultBranch),
            maxItems: maxItemsOf(step),
        };
    }
    return {
        mode: 'branch', style: 'rules', matchMode: 'first', source: '', matchOn: '',
        rules: [{ name: 'rule1', expr: str(step?.expr), value: '' }],
        defaultBranch: '', maxItems: '',
    };
}

/** Rules that become an output port: any with a name, predicate or not. */
function usableRules(route: Partial<Route> | null | undefined): RouteRule[] {
    return (Array.isArray(route?.rules) ? route.rules : []).filter((r) => r && String(r.name || '').trim());
}

const maxItemsField = (route: Partial<Route>) =>
    route.maxItems === '' || route.maxItems == null ? undefined : Number(route.maxItems);

/** The step fields a switch shape writes (shared by both modes). */
function switchFields(route: Partial<Route>, rules: RouteRule[]) {
    const cases = rules.map((r) => (route.style === 'value' ? { name: r.name, value: r.value ?? '' } : { name: r.name, expr: r.expr || '' }));
    const defaultBranch = route.defaultBranch && rules.some((r) => r.name === route.defaultBranch) ? route.defaultBranch : null;
    return {
        type: 'switch',
        expr: route.style === 'value' ? route.matchOn || '' : '',
        cases,
        defaultBranch,
        routeStyle: route.style === 'value' ? 'value' : 'rules',
        matchMode: rules.length > 1 && route.matchMode === 'all' ? 'all' : undefined,
    };
}

/** The one-output list route with the box ticked: a list switch with one case, so Otherwise is a port. */
function writeKeepRest(route: Partial<Route>, first: RouteRule): Record<string, unknown> {
    return {
        type: 'switch',
        arrayRef: route.source || '',
        expr: '',
        cases: [{ name: first.name || 'Output 1', expr: first.expr || '' }],
        defaultBranch: undefined,
        routeStyle: 'rules',
        matchMode: undefined,
        maxItems: maxItemsField(route),
    };
}

/** Items mode: one rule is a Filter (or, with the box ticked, a one-case list switch); more is a list switch. */
function writeItemsRoute(route: Partial<Route>, rules: RouteRule[], first: RouteRule | null | undefined, oneRule: boolean): Record<string, unknown> {
    if (oneRule && route.keepRest && first) return writeKeepRest(route, first);
    if (oneRule) {
        return {
            type: 'filter', arrayRef: route.source || '', expr: first?.expr || '', maxItems: maxItemsField(route),
            cases: undefined, defaultBranch: undefined, routeStyle: undefined, matchMode: undefined,
        };
    }
    return { ...switchFields(route, rules), arrayRef: route.source || '', maxItems: maxItemsField(route) };
}

/**
 * The unified model → the step fields to persist, INCLUDING `type`. Keys that
 * do not belong to the chosen type are set to `undefined`, so the patch merge
 * drops them. `matchMode` is only ever written as 'all'.
 */
export function writeRoute(route: Partial<Route>): Record<string, unknown> {
    const rules = usableRules(route);
    const first = rules[0] || (Array.isArray(route?.rules) ? route.rules[0] : null);
    const oneRule = rules.length <= 1 && route.style === 'rules';
    if (route.mode === 'items') return writeItemsRoute(route, rules, first, oneRule);
    if (oneRule) {
        return {
            type: 'condition', expr: first?.expr || '',
            arrayRef: undefined, cases: undefined, defaultBranch: undefined, maxItems: undefined,
            routeStyle: undefined, matchMode: undefined,
        };
    }
    return { ...switchFields(route, rules), arrayRef: undefined, maxItems: undefined };
}

/** The step's output ports, in order, each tagged with the slot it fills. */
export function routePorts(step: RouteStepLike | null | undefined): RoutePort[] {
    if (step?.type === 'condition') {
        return [{ slot: 0, label: PORT.then }, { slot: 'otherwise', label: PORT.else }];
    }
    if (step?.type === 'switch') {
        const cases = Array.isArray(step.cases) ? step.cases : [];
        return [
            ...cases.filter((c) => c?.name).map((c, i): RoutePort => ({ slot: i, label: `case:${c.name}`, caseName: c.name as string })),
            { slot: 'otherwise', label: PORT.defaultCaseLabel, caseName: PORT.defaultCase },
        ];
    }
    return [{ slot: 0, label: null }];
}

const caseNameOf = (edge: Partial<FlowEdge> | null | undefined, label: string | null) =>
    edge?.caseName ?? (typeof label === 'string' && label.startsWith('case:') ? label.slice(5) : null);

/** Which slot this outgoing edge occupies on `step`; null = not a branch edge. */
export function slotForEdge(step: RouteStepLike | null | undefined, edge: Partial<FlowEdge> | null | undefined): number | 'otherwise' | null {
    const label = edge?.label || null;
    if (step?.type === 'condition') {
        if (label === 'then') return 0;
        return label === 'else' ? 'otherwise' : null;
    }
    if (step?.type === 'switch') {
        const caseName = caseNameOf(edge, label);
        if (caseName == null) return null;
        if (caseName === 'default') return 'otherwise';
        const cases = Array.isArray(step.cases) ? step.cases : [];
        const i = cases.findIndex((c) => c?.name === caseName);
        return i >= 0 ? i : null;
    }
    return label == null ? 0 : null;
}
