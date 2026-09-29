// The unified Condition editor (If / Switch / Filter), extracted verbatim
// from SettingsForm.jsx.
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { walkPath } from '../../../../../utils/bindingHelpers';
import ConditionBuilder from '../../mapping/ConditionBuilder';
import PathField from '../../mapping/PathField';
import { sampleToFields } from '../../mapping/upstream';
import { VariablePickerProvider, useVariablePickerContext } from '../../mapping/VariablePickerContext';
import AccordionSection from '../AccordionSection';
import { humanizeFieldKey } from '../displayHelpers';
import { readRoute, uniqueRuleName } from '../routeModel';
import { SourceSummaryRow, CollectionArrayRefField, useElementSample } from './collectionEditors';
import { cardClass, FormRow, inputClass, rowInputClass } from './formPrimitives';
import RouteAssist from './RouteAssist';

/**
 * The unified "Condition" editor — one form for what used to be four palette
 * entries (If · Switch · Filter (route) · Filter (collection)).
 *
 * Designed so the common case needs almost no input: the mode is DETECTED
 * when the node is wired (mapping/autoMapInputs.js), the source list is a
 * one-line summary rather than a field to fill in, and each rule reads
 * "Subject contains isv" — never `item.subject`. Everything the author
 * doesn't normally touch (the mode override, the raw source path, the
 * generated expression) lives under Advanced.
 *
 * What happens to whatever matched no rule is NOT a setting: one rule keeps
 * the matches and drops the rest, several rules add an "otherwise" output.
 * flow/routeModel.js maps that onto the runtime step type
 * (`condition` / `switch` / `filter`) and flow/routeEdges.js re-points the
 * node's connections when the shape changes, so nothing ever strands an edge
 * (which would be a blocking save error — node-audit C1).
 *
 * BFSF-356 — the number of OUTPUTS is now an explicit choice at the top of the
 * section instead of a side effect of clicking "+ Add rule". One Condition
 * node covers both jobs, and which job it is doing is stated rather than
 * discovered:
 *   - "One output"      — a filter: what matches continues, the rest stops.
 *   - "Several outputs" — a router: every output is a filter with its own
 *                         destination, each with the same condition builder.
 * The canvas consequences are stated too (a renamed output keeps its
 * connection, a removed one takes it along; collapsing back to one names the
 * WIRED outputs it would cost before it costs them), and the fan-out semantic
 * — is a record allowed down several outputs at once — is an Advanced choice
 * per node, defaulting to 'all' only for a router BUILT here (see
 * routeModel.js: an absent `matchMode` is every stored router's contract).
 */
function RouteFields({
    step, draft, set, groups, onFocusField, previewSample, errorSections = new Set(), wiredCaseNames = null,
    // (step) => boolean|undefined — put a step BEFORE this node and re-point
    // its connections. Handed down from the shell that owns the definition,
    // because that is the only level that can rewrite edges; null everywhere
    // it was not, and "Suggest outputs" then does not offer the handoff at all.
    onInsertUpstreamStep = null,
    // `{ available, reason }`: offers "is about" in the conditions (the topic
    // classifier); null when the server does not say. See SettingsForm.
    topics = null,
}) {
    const pickerCtx = useVariablePickerContext();
    const route = draft.route || readRoute(step);
    const setRoute = (patch) => set('route', { ...route, ...patch });
    const rules = Array.isArray(route.rules) ? route.rules : [];
    const items = route.mode === 'items';
    const valueStyle = route.style === 'value';

    // A rule only needs a NAME when it becomes a labelled port — with a single
    // rule there is nothing to label, so the field would have no visible effect.
    const namesMatter = rules.length > 1;
    // BFSF-356: the number of outputs is an UP-FRONT choice, not something you
    // discover by clicking "+ Add rule" and watching the node change shape.
    const several = rules.length > 1;
    const fanOut = route.matchMode === 'all';
    // Which outputs would lose a canvas connection if the node collapsed back
    // to one — held in state so the click ASKS before it destroys wiring.
    const [collapseAsk, setCollapseAsk] = useState(null);

    // Scope the per-item rules to the CURRENT ITEM: an `item` group + sample
    // root so `item.<field>` resolves, datatypes infer, and drag-to-map works.
    const elementSample = useElementSample(items ? route.source : '', previewSample);
    const itemScope = useMemo(() => {
        if (!items || elementSample == null) return null;
        const isObj = typeof elementSample === 'object' && !Array.isArray(elementSample);
        const itemGroup = {
            id: '__route_item',
            label: 'Current item',
            kind: 'loop',
            basePath: 'item',
            sample: elementSample,
            fields: isObj ? sampleToFields(elementSample, 'item') : [],
        };
        return {
            groups: [itemGroup, ...(pickerCtx.groups || [])],
            previewSample: { ...(previewSample || {}), item: elementSample },
        };
    }, [items, elementSample, pickerCtx.groups, previewSample]);

    // The named fields the rule rows offer. In list mode they are the fields of
    // one item ("Subject", "From"); otherwise everything the upstream steps
    // produce, grouped by step. Paths stay internal — see FieldPicker.
    const fieldOptions = useMemo(
        () => (items ? itemFieldOptions(elementSample) : upstreamFieldOptions(pickerCtx.groups)),
        [items, elementSample, pickerCtx.groups],
    );

    // The sample rows "Suggest outputs" counts against. They are the rows the
    // editor ALREADY has — whatever the step above last produced, resolved
    // through the same path the rules will be evaluated against — never
    // anything invented for the preview. In whole-run mode there is no list to
    // count, and the box says so rather than reporting "1 of 1".
    const sampleRows = useMemo(() => {
        if (!items || !route.source) return null;
        const value = walkPath(route.source, previewSample);
        return Array.isArray(value) ? value : null;
    }, [items, route.source, previewSample]);

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
    const applySuggestion = (suggested, extra = null) => {
        const named = [];
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
    const applyHandoff = (plan) => {
        applySuggestion(plan.rules, plan.source ? { source: plan.source } : null);
    };

    const updateRule = (i, patch) => setRoute({
        rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
        // A rename must carry the "when nothing matches" pick with it.
        ...(patch.name && route.defaultBranch === rules[i]?.name ? { defaultBranch: patch.name } : null),
    });
    const addRule = () => setRoute({
        rules: [...rules, { name: uniqueRuleName(rules, `rule${rules.length + 1}`), expr: '', value: '' }],
        // The 1 → several crossing is the ONLY place fan-out is switched on: a
        // node that gains its second output here is a new router, and "every
        // output is a filter with its own destination, none of them consumes
        // the record" is the semantic the ticket describes. A node that ALREADY
        // had several outputs keeps whatever it was saved with — adding a third
        // output to a stored first-match switch must not change how the two it
        // already had behave (routeModel.js, readMatchMode).
        ...(rules.length <= 1 ? { matchMode: 'all' } : null),
    });
    const removeRule = (i) => setRoute({
        rules: rules.filter((_, j) => j !== i),
        ...(route.defaultBranch === rules[i]?.name ? { defaultBranch: '' } : null),
    });

    // ── The up-front output-count choice ─────────────────────────────────
    const outputName = (i) => (i < 26 ? `Output ${String.fromCharCode(65 + i)}` : `Output ${i + 1}`);
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
        const grown = [...rules];
        while (grown.length < 2) {
            grown.push({ name: uniqueRuleName(grown, `rule${grown.length + 1}`), expr: '', value: '' });
        }
        setRoute({ rules: grown, matchMode: 'all' });
    };

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

    const condition = (i, r) => (
        <ConditionBuilder
            value={r.expr || ''}
            onChange={(next) => updateRule(i, { expr: next })}
            onFocusField={onFocusField}
            previewSample={itemScope ? itemScope.previewSample : previewSample}
            context={items ? 'filter' : 'condition'}
            fieldOptions={fieldOptions}
            fieldBase={items ? 'item' : 'trigger.output'}
            showSerialized={false}
            topics={topics}
        />
    );
    const scoped = (node) => (itemScope ? (
        <VariablePickerProvider
            groups={itemScope.groups}
            previewSample={itemScope.previewSample}
            stepLabelById={pickerCtx.stepLabelById}
        >
            {node}
        </VariablePickerProvider>
    ) : node);

    // The generated expressions, shown under Advanced for the curious and for
    // support — the form itself never puts an expression on screen.
    const expressions = rules.map(r => r.expr).filter(Boolean);

    return (
        <>
            {items && (
                <SourceSummaryRow
                    hint="Detected from the step above. Each item is checked against the rules below."
                    source={route.source}
                    maxItems={route.maxItems}
                    onPatch={(p) => setRoute('source' in p ? { source: p.source } : { maxItems: p.maxItems })}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}

            {/* No `|| errorSections.has('source')` here any more: the taxonomy
                used to route a bad Source list to a section called 'source'
                that this editor never renders, and this check papered over it
                by opening Rules instead — the wrong band, while the Source-list
                control stayed collapsed inside Advanced. The taxonomy now says
                'advanced', which is where CollectionArrayRefField actually is. */}
            <AccordionSection stepType={step.type} sectionKey="rules" title={several ? 'Outputs' : 'Output'} defaultOpen forceOpen={errorSections.has('rules')}>
                {/* BFSF-356 — the node has ONE type in the palette and the two
                    things it can be are chosen here, out loud, before anything
                    else. "+ Add rule" used to flip the node into an
                    undocumented routing mode with no explanation anywhere. */}
                <FormRow
                    label="How many outputs does this node have?"
                    hint="One output filters: what matches continues, the rest stops here. Several outputs route."
                >
                    <div className="space-y-1.5">
                        <div className="flex gap-1" role="group" aria-label="Number of outputs">
                            {[
                                { key: 'one', label: 'One output', active: !several, onClick: chooseOne },
                                { key: 'several', label: 'Several outputs', active: several, onClick: chooseSeveral },
                            ].map(opt => (
                                <button
                                    key={opt.key}
                                    type="button"
                                    aria-pressed={opt.active}
                                    onClick={opt.onClick}
                                    className={`px-2 py-1 text-[11px] rounded border transition ${opt.active
                                        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                                        : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)]">
                            {/* An unconfigured node has no rules yet but still routes
                                everything down one path, so "0 outputs" next to a
                                pressed "One output" contradicts itself. */}
                            This node has {Math.max(1, rules.length)} {rules.length > 1 ? 'outputs' : 'output'}.
                        </div>
                        {/* There is no documentation for this node anywhere, so
                            the editor is the only place the shape can be
                            learned. */}
                        <div className="text-[10px] text-[var(--text-tertiary)]">
                            Each output is a filter with its own destination — for example Output A: Subject contains urgent,
                            Output B: Subject contains invoice.
                        </div>
                        {several && (
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {fanOut
                                    ? `Every output is checked on its own, so ${items ? 'an item' : 'a record'} that matches two outputs travels both paths. Whatever matches no output at all is dropped here — it stays counted as rejected.`
                                    : `Each ${items ? 'item' : 'record'} takes the FIRST output it matches and no other. Whatever matches no output at all is dropped here. Change this under Advanced.`}
                            </div>
                        )}
                        {several && (
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                On the canvas: an output that keeps its name keeps its connection, an output that
                                disappears takes its connection with it.
                            </div>
                        )}
                        {collapseAsk && (
                            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
                                <div className="text-[10px] text-[var(--text-primary)]">
                                    Going back to one output removes {collapseAsk.join(', ')} — {collapseAsk.length === 1 ? 'that output is' : 'those outputs are'} wired
                                    on the canvas, so {collapseAsk.length === 1 ? 'its connection goes' : 'their connections go'} too.
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={collapseToOne}
                                        className="text-[10px] text-red-500 hover:underline"
                                    >
                                        Remove them anyway
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setCollapseAsk(null)}
                                        className="text-[10px] text-[var(--text-tertiary)] hover:underline"
                                    >
                                        Keep several outputs
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </FormRow>

                {/* Describe-it-in-words, INSIDE the Outputs section rather
                    than in one of its own. A section is not a local decision:
                    flow/nodeDefs.js declares `sectionKeys` AND `simpleSections`
                    separately for condition, switch and filter, so a new one
                    means four lists to keep in step — and a section a node
                    forgot to declare simply is not there, which is how an
                    arrayRef error once opened Rules while its control sat
                    collapsed in Advanced (see the note on that above). It
                    belongs here on the merits too: what it produces is
                    outputs, and it pre-fills the chooser it sits under.
                    Not offered on a legacy value-style switch: there a rule
                    holds a value to match rather than a condition, and the
                    one-click conversion below is the way out of that shape. */}
                {!valueStyle && (
                    <RouteAssist
                        fields={fieldOptions}
                        topics={topics}
                        sampleRows={sampleRows}
                        sampleRoot={itemScope ? itemScope.previewSample : previewSample}
                        unit={items ? 'items' : 'records'}
                        existingRuleCount={rules.filter(r => String(r?.expr || '').trim()).length}
                        /* The outputs that are WIRED on the canvas right now.
                           An accept renames every output at once, and this
                           section has already promised two lines above that
                           "an output that disappears takes its connection with
                           it" — so an accept that drops a wired name has to
                           say which, the way collapsing to one output does
                           before it costs an edge. Counting configured rules
                           is not enough on its own: an output with a name but
                           no condition yet is still a real port with a real
                           edge (routeModel.js usableRules keeps it for exactly
                           that reason), so it is invisible to the "already set
                           up" count and would otherwise vanish in silence.
                           RouteAssist subtracts the names the suggestion
                           keeps, since a surviving name survives its edge. */
                        wiredOutputNames={rules.map(r => r?.name).filter(n => n && wiredCaseNames?.has?.(n))}
                        onApply={applySuggestion}
                        /* The handoff half: the list this node works through
                           (the inserted step has to be fanned out over the
                           same one), the shell's insert, and the accept that
                           writes the rules it produces. The insert is the one
                           of the three that can be absent — on a surface with
                           no definition behind it the offer is not rendered,
                           the way the form builder hides a rename the shell
                           cannot perform. */
                        sourceRef={items ? (route.source || '') : ''}
                        onInsertUpstreamStep={onInsertUpstreamStep}
                        onApplyHandoff={applyHandoff}
                    />
                )}

                {valueStyle && (
                    <FormRow label="Value to check" hint="Picked once; matched against each rule's value below.">
                        <div className="space-y-1">
                            <PathField
                                value={route.matchOn || ''}
                                onChange={(next) => setRoute({ matchOn: next })}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                placeholder="trigger.output.value"
                            />
                            <button
                                type="button"
                                onClick={convertToConditions}
                                className="text-[10px] text-[var(--accent)] hover:underline"
                            >
                                Use full conditions instead
                            </button>
                        </div>
                    </FormRow>
                )}

                <FormRow
                    label={several ? 'Conditions per output' : (items ? 'Keep when' : 'Continue when')}
                    hint={several
                        ? (fanOut
                            ? `Each output has its own condition set and is checked independently — ${items ? 'an item' : 'a record'} can match several.`
                            : `Each output has its own condition set, checked in order — the first match wins.`)
                        : (items
                            ? 'Every item is checked against this condition. Items that do not match stop here.'
                            : 'The run continues when this is true.')}
                >
                    <div className="space-y-2">
                        {rules.length === 0 && (
                            <div className="text-[11px] text-[var(--text-tertiary)] italic">No outputs yet — add one.</div>
                        )}
                        {rules.map((r, i) => (
                            <div key={i} className={namesMatter ? cardClass() : ''}>
                                {namesMatter && (
                                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                                        {outputName(i)}
                                    </div>
                                )}
                                {namesMatter && (
                                    <div className="flex items-center gap-1.5">
                                        <CaseNameInput
                                            name={r.name || ''}
                                            siblingNames={rules.filter((_, j) => j !== i).map(x => x?.name).filter(Boolean)}
                                            onCommit={(name) => updateRule(i, { name })}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => removeRule(i)}
                                            className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                                            title={wiredCaseNames?.has?.(r.name)
                                                ? 'Remove output — its canvas connection will be removed too'
                                                : 'Remove output'}
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                )}
                                {namesMatter && wiredCaseNames?.has?.(r.name) && (
                                    <div className="text-[10px] text-[var(--text-tertiary)]">
                                        Wired on the canvas — renaming keeps the connection; removing drops it.
                                    </div>
                                )}
                                {valueStyle
                                    ? <CaseValueInput type="unknown" value={r.value} onChange={(v) => updateRule(i, { value: v })} />
                                    : scoped(condition(i, r))}
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={addRule}
                            title="Each output gets its own condition set and its own port on the node"
                            className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                        >
                            <Plus size={12} /> Add output
                        </button>
                        <div className="text-[10px] text-[var(--text-tertiary)]">
                            Text comparisons ignore upper/lower case.
                        </div>
                    </div>
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType={step.type} sectionKey="advanced" title="Advanced" forceOpen={errorSections.has('advanced')}>
                <FormRow label="Deciding about" hint="Detected from the step above — override it here if the guess is wrong.">
                    <select
                        value={items ? 'items' : 'branch'}
                        onChange={(e) => setRoute(e.target.value === 'items' ? { mode: 'items' } : { mode: 'branch' })}
                        className={inputClass()}
                    >
                        <option value="items">Each item of a list</option>
                        <option value="branch">The whole run</option>
                    </select>
                </FormRow>
                {items && (
                    <CollectionArrayRefField
                        draft={{ arrayRef: route.source || '', maxItems: route.maxItems }}
                        set={(k, v) => setRoute(k === 'arrayRef' ? { source: v } : { maxItems: v })}
                        groups={groups}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                )}
                {/* The fan-out opt-in. It is a per-node CHOICE, never a
                    migration: a stored router keeps first-match-wins until
                    someone picks otherwise here, because flipping it for
                    everyone would mean duplicate mails/tickets/API writes for
                    customers who changed nothing (routeModel.js, writeRoute
                    persists 'all' and CLEARS the key for 'first'). */}
                {several && (
                    <FormRow
                        label="When several outputs match"
                        hint="Routines built before this existed keep sending each record down the first match only, until you change it here."
                    >
                        <select
                            value={fanOut ? 'all' : 'first'}
                            onChange={(e) => setRoute({ matchMode: e.target.value === 'all' ? 'all' : 'first' })}
                            className={inputClass()}
                        >
                            <option value="all">Send it to every matching output</option>
                            <option value="first">Send it to the first matching output only</option>
                        </select>
                    </FormRow>
                )}
                {rules.length > 1 && (
                    <FormRow label="When nothing matches" hint="Send unmatched values to one of your rules, or use the node's otherwise output.">
                        <select
                            value={route.defaultBranch || ''}
                            onChange={(e) => setRoute({ defaultBranch: e.target.value })}
                            className={inputClass()}
                        >
                            <option value="">Use the otherwise output</option>
                            {rules.filter(r => r.name).map(r => (
                                <option key={r.name} value={r.name}>{r.name}</option>
                            ))}
                        </select>
                    </FormRow>
                )}
                {expressions.length > 0 && (
                    <FormRow label="Expression" hint="What the rules above compile to. Read-only — edit the rules to change it.">
                        <div className="space-y-1">
                            {expressions.map((e, i) => (
                                <div key={i} className="text-[10px] font-mono text-[var(--text-tertiary)] break-all">{e}</div>
                            ))}
                        </div>
                    </FormRow>
                )}
            </AccordionSection>
        </>
    );
}

/**
 * Named fields of ONE item of the source list, one nesting level deep — the
 * options the rule rows offer in list mode ("Subject", "From · email").
 */
function itemFieldOptions(elementSample) {
    if (elementSample == null || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    const out = [];
    for (const f of sampleToFields(elementSample, 'item')) {
        out.push({ path: f.path, label: humanizeFieldKey(f.key), sample: f.sample, group: 'Fields of each item' });
        for (const c of (f.children || [])) {
            out.push({
                path: c.path,
                label: `${humanizeFieldKey(f.key)} · ${humanizeFieldKey(c.key)}`,
                sample: c.sample,
                group: 'Fields of each item',
            });
        }
    }
    return out;
}

/** Named fields of every upstream step — the options in whole-run mode. */
function upstreamFieldOptions(groups) {
    const out = [];
    for (const g of (groups || [])) {
        for (const f of (g.fields || [])) {
            out.push({ path: f.path, label: humanizeFieldKey(f.key), sample: f.sample, group: g.label });
            for (const c of (f.children || [])) {
                out.push({
                    path: c.path,
                    label: `${humanizeFieldKey(f.key)} · ${humanizeFieldKey(c.key)}`,
                    sample: c.sample,
                    group: g.label,
                });
            }
        }
    }
    return out;
}

/**
 * Case-name input that commits on blur/Enter instead of per keystroke.
 *
 * Live-controlled names fed the 600ms autosave half-typed states: a
 * select-all-and-retype passed through `''`, which buildPatch filters out of
 * `patch.cases`, which the edge reconcile then read as "case removed" — and
 * the case's canvas connection was dropped mid-typing (node-audit C1/B1a).
 * Committing only a valid final name means `draft.cases` never holds an
 * empty or duplicate name, so every flushed patch is either a clean rename
 * or an explicit trash-click removal.
 *
 * The placeholder used to read "case name (becomes the port label)" in a
 * monospace field — the last piece of raw jargon left on a beginner's main
 * path through this node, now that the mode override, the source path and the
 * compiled expression have all moved under Advanced. "Case" and "port" are
 * words from the runtime step types (routeModel.js keeps them because every
 * saved routine speaks them); nobody typing "invoices" here has met either,
 * and the monospace face said "this is code" about a field that takes plain
 * words. The name still becomes the port label — that is explained in the
 * lines beside the field, in the section that says what happens to a wired
 * output when it is renamed.
 */
function CaseNameInput({ name, siblingNames = [], onCommit }) {
    const [text, setText] = useState(name);
    const [error, setError] = useState(null);
    // Resync when the committed name changes underneath us (AI patch / undo).
    useEffect(() => { setText(name); setError(null); }, [name]);

    const commit = () => {
        const trimmed = String(text || '').trim();
        if (trimmed === name) { setText(name); setError(null); return; }
        if (!trimmed) {
            setText(name);
            setError('Name required — reverted.');
            return;
        }
        if (siblingNames.includes(trimmed)) {
            setError(`A case named “${trimmed}” already exists.`);
            return;
        }
        setError(null);
        onCommit(trimmed);
    };

    return (
        <div className="flex-1 min-w-0">
            <input
                type="text"
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                placeholder="Name this output — for example invoices"
                aria-invalid={!!error}
                className={rowInputClass('w-full', { invalid: !!error })}
            />
            {error && <div className="mt-0.5 text-[10px] text-red-500">{error}</div>}
        </div>
    );
}

/**
 * Typed "value to match" input for a switch case. When the switch expression's
 * datatype is known, render the matching control (number / boolean); otherwise
 * fall back to free text. Storage stays a plain string/number/boolean so the
 * runtime's loose-equality match is unchanged.
 */
function CaseValueInput({ type, value, onChange }) {
    if (type === 'number') {
        return (
            <input
                type="number"
                value={value == null || value === '' ? '' : value}
                onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="number to match"
                className={rowInputClass('w-full')}
            />
        );
    }
    if (type === 'boolean') {
        return (
            <select
                value={value === true ? 'true' : value === false ? 'false' : ''}
                onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')}
                className={rowInputClass('w-full')}
            >
                <option value="">(choose)</option>
                <option value="true">true</option>
                <option value="false">false</option>
            </select>
        );
    }
    return (
        <input
            type="text"
            value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
            onChange={(e) => onChange(e.target.value)}
            placeholder="value to match"
            className={rowInputClass('w-full')}
        />
    );
}

export { RouteFields };
