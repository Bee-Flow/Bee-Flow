import { useState } from 'react';
import { resolveElementSample } from '../../mapping/upstream';
import { uniqueRuleName } from '../routeModel';
import { itemNameOf, rulesForSource, withNamedFirst, withoutRowsReading, workThroughListPatch } from './routeEditorsModel';
import type { RouteRule } from './routeEditorsModel';
import type { RouteConfig, SetDraft, SuggestedRule, UnfitRules } from './routeTypes';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

interface Args {
    route: RouteConfig;
    rules: RouteRule[];
    set: SetDraft;
    previewSample: unknown;
    wiredCaseNames: Set<string> | null;
    t: Translate;
}

/**
 * Every edit the Condition editor can make to its route, as handlers over
 * `set('route', …)`, plus the two pieces of state those edits need: the
 * "collapse to one output" confirmation and the rules a list change left
 * unfit. Each edit goes through `setRoute`, so writeRoute (flow/routeModel.js)
 * still decides the runtime shape.
 */
export function useRouteEdits({ route, rules, set, previewSample, wiredCaseNames, t }: Args) {
    const setRoute = (patch: RouteConfig) => set('route', { ...route, ...patch });
    // BFSF-356: the number of outputs is an UP-FRONT choice, not something you
    // discover by clicking "+ Add rule" and watching the node change shape.
    const several = rules.length > 1;
    // Which outputs would lose a canvas connection if the node collapsed back
    // to one — held in state so the click ASKS before it destroys wiring.
    const [collapseAsk, setCollapseAsk] = useState<string[] | null>(null);
    // The rules a list change left reading fields the new item lacks (R11).
    const [unfit, setUnfit] = useState<UnfitRules | null>(null);

    // A new list (R11): rules over the inner list move onto its entry, and
    // rules the new item cannot read are named, never dropped silently.
    const changeSource = (next: string) => {
        const element = resolveElementSample(next, previewSample);
        const r = rulesForSource(rules, route.source || '', next || '', element);
        setRoute({ source: next, rules: r.rules });
        setUnfit(r.unfit.length ? { paths: r.unfit, itemName: itemNameOf(next) } : null);
    };
    const removeUnfit = () => {
        setRoute({ rules: withoutRowsReading(rules, unfit?.paths || []) });
        setUnfit(null);
    };
    // "Check each item instead": false when no rule reads an item of the list.
    const workThroughList = (list: string) => {
        const patch = workThroughListPatch(rules, list);
        if (!patch) return false;
        setRoute(patch);
        return true;
    };

    /**
     * Accept a suggestion.
     *
     * It goes through `setRoute` like every hand-made edit, so writeRoute
     * (flow/routeModel.js) still decides the runtime shape: one suggested rule
     * saves as a `filter`, several as a `switch` with an otherwise port. The
     * "How many outputs" chooser above is PRE-FILLED by the rule count — it
     * reads `rules.length`, so there is no second copy of that question to
     * keep in sync.
     *
     * matchMode follows addRule's rule exactly, and for the same reason: a node
     * crossing from one output to several is a new router and fans out, while a
     * node that already had several keeps whatever it was saved with. Pinning
     * 'all' on a stored first-match switch here would change how its existing
     * outputs behave, which is the duplicate-mail scenario routeModel.js warns
     * about.
     */
    const applySuggestion = (suggested: SuggestedRule[], extra: RouteConfig | null = null) => {
        const named: RouteRule[] = [];
        for (const r of suggested) named.push({ name: uniqueRuleName(named, r.name), expr: r.expr, value: '' });
        setRoute({
            rules: named,
            style: 'rules',
            // The old names are gone, so the "when nothing matches" pick that
            // referenced one of them is gone too — writeRoute would drop it
            // anyway; clearing it here keeps the editor honest in between.
            defaultBranch: '',
            ...(rules.length <= 1 && named.length > 1 ? { matchMode: 'all' } : null),
            ...extra,
        });
    };

    /**
     * Accept a semantic handoff — the rules, plus where to read them from.
     *
     * The step itself was already inserted by the shell; this is the half the
     * node's own draft owns. `plan.source` is the only thing that makes this
     * more than `applySuggestion`, and it is not decoration: a per-item plan
     * fans the new step out over the list this node reads, which publishes a
     * RESULTS list rather than the rows, and the rules it wrote address each
     * result (`item.output.<field>`). Leaving the old source in place would
     * point those rules at rows that never carry the answer — the silent
     * empty branch, arriving through the one door in this box that adds a
     * step. Whole-run plans carry no source and this is `applySuggestion`.
     */
    const applyHandoff = (plan: { rules: SuggestedRule[]; source?: string }) => {
        applySuggestion(plan.rules, plan.source ? { source: plan.source } : null);
    };

    const updateRule = (i: number, patch: Partial<RouteRule>) => setRoute({
        rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
        // A rename must carry the "when nothing matches" pick with it.
        ...(patch.name && route.defaultBranch === rules[i]?.name ? { defaultBranch: patch.name } : null),
    });
    // O3: outputs are "Output 1", "Output 2", …; the first one gets its
    // name when it becomes a labelled port.
    const outputName = (i: number) => t('condition_node.default_output_name', 'Output {n}', { n: i + 1 });
    const withFirstName = (list: RouteRule[]) => (list.length === 1 ? withNamedFirst(list, outputName(0)) : list);
    const addRule = () => setRoute({
        rules: [...withFirstName(rules), { name: uniqueRuleName(withFirstName(rules), outputName(rules.length)), expr: '', value: '' }],
        // The 1 → several crossing is the ONLY place fan-out is switched on: a
        // node that gains its second output here is a new router, and "every
        // output is a filter with its own destination, none of them consumes
        // the record" is the semantic the ticket describes. A node that ALREADY
        // had several outputs keeps whatever it was saved with — adding a third
        // output to a stored first-match switch must not change how the two it
        // already had behave (routeModel.js, readMatchMode).
        ...(rules.length <= 1 ? { matchMode: 'all' } : null),
    });
    // BFSF-406: reorder the outputs. Only the order of `cases` changes; edges
    // are keyed by case NAME, so each connection stays on its own output (the
    // canvas ports follow the array order).
    const moveRule = (i: number, dir: number) => {
        const j = i + dir;
        if (j < 0 || j >= rules.length) return;
        const next = rules.slice();
        [next[i], next[j]] = [next[j], next[i]];
        setRoute({ rules: next });
    };
    const removeRule = (i: number) => setRoute({
        rules: rules.filter((_, j) => j !== i),
        ...(route.defaultBranch === rules[i]?.name ? { defaultBranch: '' } : null),
    });

    // ── The up-front output-count choice ─────────────────────────────────
    const collapseToOne = () => {
        setCollapseAsk(null);
        setRoute({
            rules: rules.slice(0, 1),
            defaultBranch: '',
            matchMode: 'first',
        });
    };
    const chooseOne = () => {
        if (!several) return;
        // reconcileRouteEdges (flow/routeEdges.js) re-points what survives and
        // drops what doesn't — this only says so BEFORE the click costs an edge.
        const losing = rules
            .map((r, i) => ({ r, i }))
            .slice(1)
            .filter(({ r }) => r?.name && wiredCaseNames?.has?.(r.name))
            .map(({ r, i }) => `${outputName(i)} (${r.name})`);
        if (losing.length) { setCollapseAsk(losing); return; }
        collapseToOne();
    };
    // "Several" must LAND on several. From a node with no outputs configured yet
    // (cases: []), a single addRule() lands at one — the chooser would still show
    // "One output" pressed and the click would read as inert, on the headline
    // control of this section. Grow to two in one step instead.
    const chooseSeveral = () => {
        if (several) return;
        const grown = [...withFirstName(rules)];
        while (grown.length < 2) {
            grown.push({ name: uniqueRuleName(grown, outputName(grown.length)), expr: '', value: '' });
        }
        setRoute({ rules: grown, matchMode: 'all', keepRest: false });
    };
    // BFSF-485 F2: one output in list mode can send the rest to Otherwise.
    const setKeepRest = (on: boolean) => setRoute(on ? { keepRest: true, rules: withFirstName(rules) } : { keepRest: false });

    // Legacy switches match ONE value against per-case values. They stay
    // editable as-is, and convert to full conditions in one click (lossless:
    // `<value to check> == "<case value>"`).
    const convertToConditions = () => setRoute({
        style: 'rules',
        rules: rules.map(r => ({
            ...r,
            expr: r.expr || `${route.matchOn || 'value'} == ${typeof r.value === 'string' ? JSON.stringify(r.value) : String(r.value)}`,
        })),
    });

    return {
        setRoute, collapseAsk, setCollapseAsk, unfit, changeSource, removeUnfit, workThroughList, applySuggestion, applyHandoff,
        updateRule, outputName, addRule, moveRule, removeRule, collapseToOne, chooseOne, chooseSeveral, setKeepRest, convertToConditions,
    };
}
