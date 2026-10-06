import { useEffect, useMemo, useState } from 'react';
import { summariseData } from './flow/dataSummary';
import { humanizeFieldKey } from './flow/displayHelpers';
import { stepNumbers } from './flow/flowOrder';
import { stepPayload } from './flow/stepPayload';
import { isInlineId, parseInlineId } from './flow/inlineFlowlets';
import { matchValidationToStep } from './flow/matchValidationToStep';
import type { DataSummary, FlowDefinition, FlowEdge, FlowStep, RunStepRow } from './flow/types';
import { usedPathsIn } from './mapping/boundPaths';
import { buildRealOutputMap, buildSampleRoot } from './mapping/realOutputs';
import { buildToolOutputMap, describeNode } from './mapping/upstream';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useUpstreamVariables from '../../../hooks/useUpstreamVariables';
import type { UpstreamGroup } from '../../../hooks/useUpstreamVariables';
import { walkPath } from '../../../utils/bindingHelpers';
import { initialValues } from '../../forms/PublicFormRenderer';

/** The tool schemas the editor draws its output guesses from. */
export interface ToolCatalog {
    triggerOutputs?: Record<string, unknown>;
    [key: string]: unknown;
}

/** What the validator said about ONE step. */
export interface StepIssues {
    errors: unknown[];
    warnings: unknown[];
}

/**
 * "1 of 4", and "runs 4× · one per <list>". Every member comes off the loop
 * step's row in the LAST RUN, so the two pills can never disagree.
 */
export interface LoopContext {
    iteration: { index: number; total: number; truncated: boolean; skipped: number };
    runs: number;
    /** The loop hit its maxIterations ceiling and dropped the tail. */
    truncated: boolean;
    skipped: number;
    listLabel: string | null;
    /** A step that runs once per item: what ONE item is ("attachment"); null for a Loop. */
    itemNoun?: string | null;
}

/** Everything the step editor derives from its props — facts, never edits. */
export interface NodeDetailData {
    catalog: ToolCatalog | null;
    /** A definition.triggers[] entry: webhook/app_event only. */
    isSecondaryTrigger: boolean;
    /** Switch cases with an outgoing edge; null when this is not a switch. */
    wiredCaseNames: Set<string> | null;
    stepEdges: FlowEdge[];
    groups: UpstreamGroup[];
    previewSample: unknown;
    stepTypeById: Map<string, string | undefined>;
    stepNumberById: Map<string, number | string>;
    usedPaths: Set<string>;
    stepIssues: StepIssues;
    /** The describers' guess at this node's own output — a seed, never a promise. */
    describedSample: unknown;
    /** A form's declared answers with every value empty; null for other nodes. */
    emptyFormAnswers: Record<string, unknown> | null;
    loopContext: LoopContext | null;
    inSummary: DataSummary | null;
    outSummary: DataSummary | null;
}

// The four modules aliased here are still JavaScript, and their optional
// parameters carry `= null` defaults that TypeScript reads as those
// parameters' whole type. These state the contracts their own headers
// describe; they go away when those modules become TypeScript.
const summarise = summariseData as (value: unknown) => DataSummary | null;
const numbersFor = stepNumbers as (
    definition: FlowDefinition | null | undefined,
    helpers: { isInlineId?: typeof isInlineId; parseInlineId?: typeof parseInlineId },
) => Map<string, number | string>;
const describe = describeNode as (
    node: FlowStep,
    definition: FlowDefinition | null | undefined,
    toolToOutput: Map<string, unknown>,
    triggerOutputs: Record<string, unknown>,
    sampleRoot?: unknown,
    catalog?: ToolCatalog | null,
) => { sample?: unknown } | null;
const emptyAnswersFor = initialValues as (fields: unknown[]) => Record<string, unknown>;

export interface UseNodeDetailDataOptions {
    step: FlowStep | null | undefined;
    /** This step's row in the last run. */
    runStep?: RunStepRow | null;
    runSteps?: RunStepRow[];
    /** The graph on screen — a flowlet's mini-definition while scoped. */
    definition: FlowDefinition | null | undefined;
    /** The whole document, when `definition` is a flowlet. */
    rootDefinition?: FlowDefinition | null;
    validation?: { errors?: unknown[]; warnings?: unknown[] } | null;
    /** The owner's catalog copy; absent on stand-alone mounts, which fetch one. */
    catalog?: ToolCatalog | null;
    realOutputById?: ReadonlyMap<string, unknown> | null;
}

/**
 * Everything the step editor DERIVES from its props: the tool catalog, the
 * upstream variable groups and the preview sample built from them, the
 * describers' guess at this node's own output, and the summaries the headers
 * and the In → Out line state. No editing state lives here — a value in this
 * hook is a fact about the definition, the catalog or the last run.
 */
export default function useNodeDetailData({
    step, runStep, runSteps, definition, rootDefinition, validation,
    catalog: catalogProp, realOutputById,
}: UseNodeDetailDataOptions): NodeDetailData {
    // Catalog (tool schemas): use the owner's copy when provided (BuildTab
    // already fetched it — no duplicate request); fetch only as a fallback
    // for stand-alone mounts. Upstream groups + preview sample derive from
    // the definition + this step.
    const api = useAutomationApi();
    const [fetchedCatalog, setFetchedCatalog] = useState<ToolCatalog | null>(null);
    useEffect(() => {
        if (catalogProp) return undefined;
        let alive = true;
        api.getCatalog<ToolCatalog>().then(c => { if (alive) setFetchedCatalog(c); }).catch(() => {});
        return () => { alive = false; };
    }, [api, catalogProp]);
    const catalog = catalogProp || fetchedCatalog;

    // Secondary triggers (definition.triggers[]) may only be webhook/app_event
    // — the validator hard-rejects everything else there. The kind <select>
    // needs to know, or it offers schedule/manual and the pick 400s (C7).
    const isSecondaryTrigger = !!step && (definition?.triggers || []).some(t => t?.id === step.id);

    // Which of a switch node's cases have an outgoing edge on the canvas —
    // the Cases editor tells the user a rename keeps that connection and a
    // removal drops it (node-audit B1).
    const wiredCaseNames = useMemo(() => {
        if (step?.type !== 'switch') return null;
        const names = new Set<string>();
        for (const e of (definition?.edges || [])) {
            if (e.from !== step.id) continue;
            if (e.caseName != null) names.add(e.caseName);
            else if (typeof e.label === 'string' && e.label.startsWith('case:')) names.add(e.label.slice(5));
        }
        return names;
    }, [step?.type, step?.id, definition?.edges]);

    // This step's outgoing edges. The Privacy Shield mode selector uses them to
    // name the connections a mode switch would drop (a check branches, a hide
    // does not), before the switch costs them — flow/privacyModel.js.
    const stepEdges = useMemo(
        () => (definition?.edges || []).filter(e => e?.from === step?.id),
        [step?.id, definition?.edges],
    );

    // Real outputs: prefer the owner's map; derive locally for stand-alone
    // mounts. The overlay happens inside computeUpstreamGroups, so groups,
    // pickers and the preview root all agree on what the real data is.
    const effectiveRealOutputs = useMemo(
        () => realOutputById ?? buildRealOutputMap(definition, runSteps),
        [realOutputById, definition, runSteps],
    );
    const groups = useUpstreamVariables(definition, step?.id, catalog, effectiveRealOutputs);
    const previewSample = useMemo(() => buildSampleRoot(groups), [groups]);
    // For the Incoming column and the reference pills: each source step's
    // type (→ family colour), its number on the canvas, and which of its
    // fields this step already binds (mapping/boundPaths.js).
    const stepTypeById = useMemo(() => {
        const m = new Map<string, string | undefined>();
        for (const tr of [definition?.trigger, ...(definition?.triggers || [])]) if (tr?.id) m.set(tr.id, 'trigger');
        for (const st of definition?.steps || []) if (st?.id) m.set(st.id, st.type);
        return m;
    }, [definition]);
    const stepNumberById = useMemo(() => numbersFor(definition, { isInlineId, parseInlineId }), [definition]);
    const usedPaths = useMemo(() => usedPathsIn(step), [step]);
    const stepIssues = useMemo(() => matchValidationToStep(validation, step?.id), [step, validation]);

    // ── "What does this node produce?" ───────────────────────
    // The same describers the INPUT tree uses on upstream nodes, pointed at
    // THIS one — so the shape the Edit-output sheet seeds with is the shape
    // every picker downstream already promises. A seed only: the author owns
    // whatever they actually save.
    const toolToOutput = useMemo(() => buildToolOutputMap(catalog), [catalog]);
    const describedSample = useMemo(() => {
        if (!step) return null;
        // describeNode routes on `__isTrigger`, not on step.type — that flag is
        // how collectUpstream marks a trigger for it.
        const node = step.type === 'trigger' ? { ...step, __isTrigger: true } : step;
        try {
            return describe(node, definition, toolToOutput, catalog?.triggerOutputs || {}, previewSample, catalog)?.sample ?? null;
        } catch {
            // A describer is a convenience, never a reason the editor can't open.
            return null;
        }
    }, [step, definition, toolToOutput, catalog, previewSample]);

    // A form's declared answers with every value empty — BFSF-408(b), "see the
    // key set without filling anything in". Reuses the renderer's OWN seed
    // (PublicFormRenderer.initialValues) rather than a third sample generator,
    // so what the author saves is literally the shape an untouched submission
    // has, display-only fields excluded.
    const emptyFormAnswers = useMemo(() => {
        const isFormNode = (step?.type === 'trigger' && step?.kind === 'form') || step?.type === 'form_page';
        const fields = isFormNode ? step?.form?.fields : null;
        return Array.isArray(fields) && fields.length ? emptyAnswersFor(fields) : null;
    }, [step]);
    // "1 of 4" on the loop-item block, and "runs 4× · one per <list>" on the
    // Settings column header (artboard 2b). BOTH come off the LAST RUN's loop
    // row — `{ iterations, results, totalItems? }` (execFlow.js) — because the
    // count is a fact about data that has been fetched, never about a list
    // nobody has looked at yet. No run, no pill.
    const loopContext = useMemo(
        () => resolveLoopContext({ groups, definition, rootDefinition, stepId: step?.id, runSteps }),
        [groups, definition, rootDefinition, step?.id, runSteps],
    );

    // "What goes in, what comes out" — the quick view's one line of data, and
    // the header of the full view's Output column.
    const inSummary = useMemo(
        () => resolveInSummary({ groups, previewSample, loopContext }),
        [groups, previewSample, loopContext],
    );
    const outSummary = useMemo(() => {
        const out = runStep?.output ?? (step?.pinnedOutput ?? null);
        // A Code step's output is `{ result, logs, httpCalls }`: count the
        // result, not the console lines next to it.
        return summarise(stepPayload(step?.type, out));
    }, [runStep?.output, step?.pinnedOutput, step?.type]);
    return {
        catalog,
        isSecondaryTrigger,
        wiredCaseNames,
        stepEdges,
        groups,
        previewSample,
        stepTypeById,
        stepNumberById,
        usedPaths,
        stepIssues,
        describedSample,
        emptyFormAnswers,
        loopContext,
        inSummary,
        outSummary,
    };
}

/**
 * "1 record" on the Incoming header, and the "In …" half of the footer's
 * In → Out line (artboard 2a).
 *
 * It is a COUNT — "two mails arrived" — so it obeys the same rule as every
 * other counted claim in this drawer: it is a fact about data that has been
 * fetched, never about a shape somebody drew. That distinction is easy to lose
 * here, because the merged sample root is built out of the CATALOG's curated
 * design samples (builderCatalog serves `outputSample` so the variable tree
 * has realistic placeholders without a dry run). Summarising it unconditionally
 * put "In 2 records → Out not run yet" on a never-run Gmail search: the right
 * half refusing to guess, the left half counting two invented mails, in one
 * sentence.
 *
 * So the claim needs evidence, and there are exactly two kinds:
 *   - the nearest group was OVERLAID with a real run or pinned output
 *     (upstream.overlayGroupWithReal sets `hasRealData`), or
 *   - the nearest group is the loop's "current item", whose sample is DERIVED
 *     from the list the loop ran over — and `loopContext` is non-null only
 *     when that loop has a row in the last run, which is the same evidence one
 *     step removed.
 * Anything else stays silent. The tree below still shows typed placeholders;
 * placeholders are not a count.
 */
export function resolveInSummary({ groups = [], previewSample = null, loopContext = null }: {
    groups?: UpstreamGroup[];
    previewSample?: unknown;
    loopContext?: LoopContext | null;
} = {}): DataSummary | null {
    const nearest = (groups || [])[groups.length - 1];
    if (!nearest) return null;
    const fromLoopRun = String(nearest.basePath || '').startsWith('loop.') && !!loopContext;
    if (!nearest.hasRealData && !fromLoopRun) return null;
    return summarise(walkPath(nearest.basePath, previewSample) ?? nearest.sample);
}

/** The loop step's own row in the last run, as execFlow.js writes it. */
interface LoopRunOutput {
    iterations?: number;
    results?: unknown[];
    /** Only written beside `truncated: true`, when the loop hit its cap. */
    totalItems?: number;
    truncated?: boolean;
}

/**
 * "This step is inside a loop, and here is what the last run says about it."
 *
 * Returns `{ iteration: {index,total}, runs, listLabel }` or null. Everything
 * comes from ONE place — the loop step's row in the last run (execFlow writes
 * `{ iterations, results, totalItems? }`) — so the "1 of 4" pill in the
 * Incoming column and the "runs 4×" pill on the Settings header can never
 * disagree. `index` is 1 because the sample the drawer resolves against is the
 * FIRST item (upstream.inferLoopItemSample); saying anything else would be a
 * claim about an iteration this panel is not showing.
 *
 * The loop's id is found from the loop-item GROUP (whose id is the loop step's
 * id, possibly with upstream's `__foreach` suffix), and — for the expanded
 * loop body, whose group is the synthetic `__loop_item` — from the edited
 * step's own inline prefix.
 */
export function resolveLoopContext({ groups = [], definition = null, rootDefinition = null, stepId = null, runSteps = [] }: {
    groups?: UpstreamGroup[];
    definition?: FlowDefinition | null;
    rootDefinition?: FlowDefinition | null;
    stepId?: string | null;
    runSteps?: RunStepRow[];
}): LoopContext | null {
    // The step's own item first: a per-item step over a list inside a list
    // also lists its outer items (`…__parent_<var>`), which are not its loop.
    const itemGroup = (groups || []).find(g => String(g?.id || '').endsWith('__foreach'))
        || (groups || []).find(g => String(g?.basePath || '').startsWith('loop.'));
    if (!itemGroup) return null;
    const candidates: string[] = [];
    const gid = String(itemGroup.id || '');
    if (gid && gid !== '__loop_item') candidates.push(gid.replace(/__foreach$/, ''));
    // An expanded loop body: `loop_abc__2` names the container in its prefix.
    if (stepId && isInlineId(stepId)) {
        const { prefix } = parseInlineId(stepId) || {};
        if (prefix) candidates.push(prefix);
    }
    const graph = [...((definition?.steps) || []), ...((rootDefinition?.steps) || [])];
    // Never the synthetic entry node. On an EXPANDED loop the group's id is
    // `lp1/__item__`, which is a real member of the flat graph — type
    // `loop_item`, label "Each item" — so taking the first candidate that
    // exists made the pill read "runs 2× · one per Each item" where the
    // artboard says "one per bank". The list's name is the loop's name; the
    // entry pill is chrome. Excluding one type rather than requiring `loop`
    // keeps the per-item (`__foreach`) case, where the step is not a loop at
    // all, on its own label.
    const loopStep = candidates
        .map(id => graph.find(s => s?.id === id))
        .find(s => s && s.type !== 'loop_item') || null;

    const row = candidates
        .map(id => (runSteps || []).find(r => r?.stepId === id && r?.output))
        .find(Boolean);
    const out = row?.output && typeof row.output === 'object' ? row.output as LoopRunOutput : null;
    const total = Number(out?.totalItems ?? out?.iterations ?? (Array.isArray(out?.results) ? out.results.length : 0)) || 0;
    if (!total) return null;
    const runs = Number(out?.iterations) || total;
    // The CAP. execFlow writes `totalItems` in one place only — beside
    // `truncated: true`, when the loop hit its maxIterations ceiling and
    // dropped the tail (its own comment: "a loop that hit its iteration cap
    // used to drop the tail silently"). Reading the total and throwing that
    // flag away put the two facts in different columns with nothing joining
    // them: "1 of 100" in Incoming, "runs 10×" on Settings, and no sentence
    // anywhere saying the other 90 were never processed. The flag travels with
    // the number it qualifies.
    const truncated = !!out?.truncated;
    return {
        iteration: { index: 1, total, truncated, skipped: truncated ? Math.max(0, total - runs) : 0 },
        runs,
        truncated,
        skipped: truncated ? Math.max(0, total - runs) : 0,
        // "one per <the list it loops over>" — the loop's own label is what the
        // author named it, which is what 2b's "één per bank" is.
        listLabel: loopStep?.label || itemGroup.label || null,
        // A per-item step is named after its ITEM, not after itself: its label
        // ("Download each attachment") read "one per Download each attachment".
        itemNoun: perItemNoun(loopStep),
    };
}

function perItemNoun(step: unknown): string | null {
    const fe = step && typeof step === 'object' && (step as { type?: string }).type !== 'loop'
        ? (step as { forEach?: { itemVar?: unknown } }).forEach : null;
    const itemVar = fe && typeof fe.itemVar === 'string' && fe.itemVar ? fe.itemVar : null;
    return itemVar ? humanizeFieldKey(itemVar).toLowerCase() : null;
}
