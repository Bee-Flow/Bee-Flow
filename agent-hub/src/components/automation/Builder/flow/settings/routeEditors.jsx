// The unified Condition editor (If / Switch / Filter), extracted verbatim
// from SettingsForm.jsx.
import { getList } from '@shared/expr/path.mjs';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import ConditionBuilder from '../../mapping/ConditionBuilder';
import PathField from '../../mapping/PathField';
import { resolveElementSample, sampleToFields } from '../../mapping/upstream';
import { VariablePickerProvider, useVariablePickerContext } from '../../mapping/VariablePickerContext';
import AccordionSection from '../AccordionSection';
import { humanizeFieldKey } from '../displayHelpers';
import { readRoute, uniqueRuleName } from '../routeModel';
import { SourceSummaryRow, CollectionArrayRefField, useElementSample } from './collectionEditors';
import { cardClass, FormRow, inputClass, rowInputClass } from './formPrimitives';
import { INLINE_LINK } from './formStyles';
import RouteAssist from './RouteAssist';
import {
    fieldNameOf, itemNameOf, listUnitOf, ruleFieldMenu, rulesForSource, withNamedFirst, withoutRowsReading, workThroughListPatch,
} from './routeEditorsModel';
import { OutputsChooser } from './routeEditorsOutputs';
import { NoticeFixAnchor, StaleSuccessorsNotice, UnfitRulesNotice, useNoticeFix, WholeListNotice } from './SourceNotices';

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
    // `{ stale, follow }`: next steps that still read the list this node
    // filters, and the fix (useNodeDetailData; W7). null when none apply.
    routeFollow = null,
    // `{ lists, loops }`: a whole-run Condition that reads a list as a whole,
    // and the loops after it (useNodeDetailData; BFSF-485). null otherwise.
    wholeRun = null,
}) {
    const { t } = useTranslation();
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
    // The rules a list change left reading fields the new item lacks (R11).
    const [unfit, setUnfit] = useState(null);
    const itemName = useMemo(() => itemNameOf(route.source), [route.source]);
    // A notice's fix removes the notice: focus goes here instead of <body>.
    const noticeFix = useNoticeFix();

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
        () => (items ? ruleFieldMenu(elementSample, itemName, t) : upstreamFieldOptions(pickerCtx.groups)),
        [items, elementSample, itemName, t, pickerCtx.groups],
    );

    // The sample rows "Suggest outputs" counts against. They are the rows the
    // editor ALREADY has — whatever the step above last produced, resolved
    // through the same path the rules will be evaluated against — never
    // anything invented for the preview. In whole-run mode there is no list to
    // count, and the box says so rather than reporting "1 of 1". Read with
    // the run's own list reader, so a list held as JSON text counts too (R10).
    const sampleRows = useMemo(
        () => (items && route.source && previewSample ? getList(previewSample, route.source) : null),
        [items, route.source, previewSample],
    );

    // A new list (R11): rules over the inner list move onto its entry, and
    // rules the new item cannot read are named, never dropped silently.
    const changeSource = (next) => {
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
    const workThroughList = (list) => {
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
    // O3: outputs are "Output 1", "Output 2", …; the first one gets its
    // name when it becomes a labelled port.
    const outputName = (i) => t('condition_node.default_output_name', 'Output {n}', { n: i + 1 });
    const withFirstName = (list) => (list.length === 1 ? withNamedFirst(list, outputName(0)) : list);
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
    const removeRule = (i) => setRoute({
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
    const setKeepRest = (on) => setRoute(on ? { keepRest: true, rules: withFirstName(rules) } : { keepRest: false });

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
                    hint={t('automations.route_editors.detected_from_the_step_above_each', 'Detected from the step above. Each item is checked against the rules below.')}
                    source={route.source}
                    maxItems={route.maxItems}
                    onPatch={(p) => ('source' in p ? changeSource(p.source) : setRoute({ maxItems: p.maxItems }))}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {items && <StaleSuccessorsNotice routeFollow={routeFollow} onFixed={noticeFix.done} />}
            {items && unfit && (
                <UnfitRulesNotice
                    unfit={unfit.paths.map(p => fieldNameOf(p, t))}
                    itemName={unfit.itemName}
                    onRemove={removeUnfit}
                    onFixed={noticeFix.done}
                />
            )}
            {!items && !valueStyle && (
                <WholeListNotice wholeRun={wholeRun} onConvert={workThroughList} onFixed={noticeFix.done} />
            )}
            <NoticeFixAnchor fix={noticeFix} />

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
                <OutputsChooser
                    ruleCount={rules.length}
                    fanOut={fanOut}
                    items={items}
                    keepRest={!!route.keepRest}
                    canKeepRest={!valueStyle}
                    onChoose={(next) => (next === 'several' ? chooseSeveral() : chooseOne())}
                    onKeepRest={setKeepRest}
                    collapseAsk={collapseAsk}
                    onConfirmCollapse={collapseToOne}
                    onCancelCollapse={() => setCollapseAsk(null)}
                />

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
                        /* After an accept: does a row matching several outputs
                           go down each (applySuggestion's matchMode rule), and
                           do unmatched rows go to Otherwise (keep-rest)? */
                        fanOut={fanOut || rules.length <= 1}
                        keepRest={items && !!route.keepRest}
                        itemSample={items ? elementSample : null}
                        onWorkThroughList={items ? changeSource : null}
                        sampleRoot={itemScope ? itemScope.previewSample : previewSample}
                        unit={items ? listUnitOf(route.source) : 'records'}
                        perItem={items}
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
                    <FormRow label={t('automations.route_editors.value_to_check', 'Value to check')} hint={t('automations.route_editors.picked_once_matched_against_each_rule', 'Picked once; matched against each rule\'s value below.')}>
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
                                className={`text-[10px] ${INLINE_LINK}`}
                            >
                                {t('automations.route_editors.use_full_conditions_instead', 'Use full conditions instead')}
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
                            ? (route.keepRest
                                ? t('condition_node.otherwise.one_keep', 'What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')
                                : 'Every item is checked against this condition. Items that do not match stop here.')
                            : 'The run continues when this is true.')}
                >
                    <div className="space-y-2">
                        {rules.length === 0 && (
                            <div className="text-[11px] text-[var(--text-tertiary)] italic">{t('automations.route_editors.no_outputs_yet_add_one', 'No outputs yet — add one.')}</div>
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
                                        {t('automations.route_editors.wired_on_the_canvas_renaming_keeps', 'Wired on the canvas — renaming keeps the connection; removing drops it.')}
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
                            title={t('automations.route_editors.each_output_gets_its_own_condition', 'Each output gets its own condition set and its own port on the node')}
                            className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                        >
                            <Plus size={12} /> {t('automations.route_editors.add_output', 'Add output')}
                        </button>
                        <div className="text-[10px] text-[var(--text-tertiary)]">
                            {t('automations.route_editors.text_comparisons_ignore_upper_lower_case', 'Text comparisons ignore upper/lower case.')}
                        </div>
                    </div>
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType={step.type} sectionKey="advanced" title={t('automations.route_editors.advanced', 'Advanced')} forceOpen={errorSections.has('advanced')}>
                <FormRow label={t('automations.route_editors.deciding_about', 'Deciding about')} hint={t('automations.route_editors.detected_from_the_step_above_override', 'Detected from the step above — override it here if the guess is wrong.')}>
                    <select
                        value={items ? 'items' : 'branch'}
                        onChange={(e) => setRoute(e.target.value === 'items' ? { mode: 'items' } : { mode: 'branch' })}
                        className={inputClass()}
                    >
                        <option value="items">{t('automations.route_editors.each_item_of_a_list', 'Each item of a list')}</option>
                        <option value="branch">{t('automations.route_editors.the_whole_run', 'The whole run')}</option>
                    </select>
                </FormRow>
                {items && (
                    <CollectionArrayRefField
                        draft={{ arrayRef: route.source || '', maxItems: route.maxItems }}
                        set={(k, v) => (k === 'arrayRef' ? changeSource(v) : setRoute({ maxItems: v }))}
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
                        label={t('automations.route_editors.when_several_outputs_match', 'When several outputs match')}
                        hint={t('automations.route_editors.automations_built_before_this_existed_keep', 'Automations built before this existed keep sending each record down the first match only, until you change it here.')}
                    >
                        <select
                            value={fanOut ? 'all' : 'first'}
                            onChange={(e) => setRoute({ matchMode: e.target.value === 'all' ? 'all' : 'first' })}
                            className={inputClass()}
                        >
                            <option value="all">{t('automations.route_editors.send_it_to_every_matching_output', 'Send it to every matching output')}</option>
                            <option value="first">{t('automations.route_editors.send_it_to_the_first_matching', 'Send it to the first matching output only')}</option>
                        </select>
                    </FormRow>
                )}
                {rules.length > 1 && (
                    <FormRow label={t('automations.route_editors.when_nothing_matches', 'When nothing matches')} hint={t('automations.route_editors.send_unmatched_values_to_one_of', 'Send unmatched values to one of your rules, or use the node\'s otherwise output.')}>
                        <select
                            value={route.defaultBranch || ''}
                            onChange={(e) => setRoute({ defaultBranch: e.target.value })}
                            className={inputClass()}
                        >
                            <option value="">{t('condition_node.otherwise.use', 'Use the Otherwise output')}</option>
                            {rules.filter(r => r.name).map(r => (
                                <option key={r.name} value={r.name}>{r.name}</option>
                            ))}
                        </select>
                    </FormRow>
                )}
                {expressions.length > 0 && (
                    <FormRow label={t('automations.route_editors.expression', 'Expression')} hint={t('automations.route_editors.what_the_rules_above_compile_to', 'What the rules above compile to. Read-only — edit the rules to change it.')}>
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
 * saved automation speaks them); nobody typing "invoices" here has met either,
 * and the monospace face said "this is code" about a field that takes plain
 * words. The name still becomes the port label — that is explained in the
 * lines beside the field, in the section that says what happens to a wired
 * output when it is renamed.
 */
function CaseNameInput({ name, siblingNames = [], onCommit }) {
    const { t } = useTranslation();
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
                placeholder={t('automations.route_editors.name_this_output_for_example_invoices', 'Name this output — for example invoices')}
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
    const { t } = useTranslation();
    if (type === 'number') {
        return (
            <input
                type="number"
                value={value == null || value === '' ? '' : value}
                onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder={t('automations.route_editors.number_to_match', 'number to match')}
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
                <option value="">{t('automations.route_editors.choose', '(choose)')}</option>
                <option value="true">{t('automations.route_editors.true', 'true')}</option>
                <option value="false">{t('automations.route_editors.false', 'false')}</option>
            </select>
        );
    }
    return (
        <input
            type="text"
            value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('automations.route_editors.value_to_match', 'value to match')}
            className={rowInputClass('w-full')}
        />
    );
}

export { RouteFields };
