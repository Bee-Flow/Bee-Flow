// The unified Condition editor (If / Switch / Filter), extracted verbatim
// from SettingsForm.jsx.
import type { ComponentProps } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import ConditionBuilder from '../../mapping/ConditionBuilder';
import { VariablePickerProvider, useVariablePickerContext } from '../../mapping/VariablePickerContext';
import AccordionSection from '../AccordionSection';
import { readRoute } from '../routeModel';
import { SourceSummaryRow } from './collectionEditors';
import { RouteAdvancedFields } from './routeAdvanced';
import RouteAssist from './RouteAssist';
import { fieldNameOf, listUnitOf, type RouteRule } from './routeEditorsModel';
import { OutputsChooser } from './routeEditorsOutputs';
import { RouteRuleList, RouteValueToCheck } from './routeRuleList';
import { NoticeFixAnchor, StaleSuccessorsNotice, UnfitRulesNotice, useNoticeFix, WholeListNotice, type RouteFollow, type WholeRun } from './SourceNotices';
import { useRouteEdits } from './useRouteEdits';
import { useRouteScope } from './useRouteScope';
import type { RouteConfig, SetDraft } from './routeTypes';
import type { OnFocusField } from '../../mapping/focusField.types';
import type { TopicsCapability } from '../../mapping/TopicNotice';
import type { Group, UpstreamNode } from '../../mapping/upstream/upstream.types';

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
interface RouteFieldsProps {
    step: UpstreamNode & { type: string };
    draft: { route?: RouteConfig };
    set: SetDraft;
    groups: Group[] | null;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
    onInsertUpstreamStep?: ComponentProps<typeof RouteAssist>['onInsertUpstreamStep'];
    topics?: TopicsCapability | null;
    wiredCaseNames?: Set<string> | null;
    routeFollow?: RouteFollow | null;
    wholeRun?: WholeRun | null;
}

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
}: RouteFieldsProps) {
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext();
    const route = draft.route || readRoute(step);
    const rules = Array.isArray(route.rules) ? route.rules : [];
    const items = route.mode === 'items';
    const valueStyle = route.style === 'value';
    const several = rules.length > 1;
    const fanOut = route.matchMode === 'all';
    const edits = useRouteEdits({ route, rules, set, previewSample, wiredCaseNames, t });
    // A notice's fix removes the notice: focus goes here instead of <body>.
    const noticeFix = useNoticeFix();
    const { elementSample, itemScope, fieldOptions, sampleRows } = useRouteScope({
        route, items, previewSample, pickerGroups: pickerCtx.groups, t,
    });

    const condition = (i: number, r: RouteRule) => {
        const builder = (
            <ConditionBuilder
                value={r.expr || ''}
                onChange={(next) => edits.updateRule(i, { expr: next })}
                onFocusField={onFocusField}
                previewSample={itemScope ? itemScope.previewSample : previewSample}
                context={items ? 'filter' : 'condition'}
                fieldOptions={fieldOptions}
                fieldBase={items ? 'item' : 'trigger.output'}
                showSerialized={false}
                topics={topics}
            />
        );
        return itemScope ? (
            <VariablePickerProvider
                groups={itemScope.groups}
                previewSample={itemScope.previewSample}
                stepLabelById={pickerCtx.stepLabelById}
            >
                {builder}
            </VariablePickerProvider>
        ) : builder;
    };

    return (
        <>
            {items && (
                <SourceSummaryRow
                    hint={t('automations.route_editors.detected_from_the_step_above_each', 'Detected from the step above. Each item is checked against the rules below.')}
                    source={route.source}
                    maxItems={route.maxItems}
                    onPatch={(p) => ('source' in p ? edits.changeSource(String(p.source)) : edits.setRoute({ maxItems: p.maxItems }))}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {items && <StaleSuccessorsNotice routeFollow={routeFollow} onFixed={noticeFix.done} />}
            {items && edits.unfit && (
                <UnfitRulesNotice
                    unfit={edits.unfit.paths.map(p => fieldNameOf(p, t))}
                    itemName={edits.unfit.itemName}
                    onRemove={edits.removeUnfit}
                    onFixed={noticeFix.done}
                />
            )}
            {!items && !valueStyle && (
                <WholeListNotice wholeRun={wholeRun} onConvert={edits.workThroughList} onFixed={noticeFix.done} />
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
                    onChoose={(next) => (next === 'several' ? edits.chooseSeveral() : edits.chooseOne())}
                    onKeepRest={edits.setKeepRest}
                    collapseAsk={edits.collapseAsk}
                    onConfirmCollapse={edits.collapseToOne}
                    onCancelCollapse={() => edits.setCollapseAsk(null)}
                />

                {/* Describe-it-in-words lives INSIDE Outputs (nodeDefs.js declares
                    sections per node, so a new section is four lists to keep in
                    step). Not offered on a legacy value-style switch: there a rule
                    holds a value to match rather than a condition, and the
                    one-click conversion below is the way out of that shape. */}
                {!valueStyle && (
                    <RouteAssist
                        fields={fieldOptions}
                        topics={topics}
                        sampleRows={sampleRows}
                        // After an accept: does a row matching several outputs go
                        // down each, and do unmatched rows go to Otherwise?
                        fanOut={fanOut || rules.length <= 1}
                        keepRest={items && !!route.keepRest}
                        itemSample={items ? elementSample : null}
                        onWorkThroughList={items ? edits.changeSource : null}
                        sampleRoot={itemScope ? itemScope.previewSample : previewSample}
                        unit={items ? listUnitOf(route.source) : 'records'}
                        perItem={items}
                        existingRuleCount={rules.filter(r => String(r?.expr || '').trim()).length}
                        // The outputs WIRED on the canvas right now: an accept that
                        // drops a wired name has to say which. An output with a name
                        // but no condition is still a real port with a real edge
                        // (routeModel.js usableRules), so the rule count alone would
                        // let it vanish in silence.
                        wiredOutputNames={rules.map(r => r?.name).filter(n => n && wiredCaseNames?.has?.(n))}
                        onApply={edits.applySuggestion}
                        // The handoff half; the insert may be absent (no definition
                        // behind this surface), and the offer is then not rendered.
                        sourceRef={items ? (route.source || '') : ''}
                        onInsertUpstreamStep={onInsertUpstreamStep}
                        onApplyHandoff={edits.applyHandoff}
                    />
                )}

                {valueStyle && (
                    <RouteValueToCheck
                        matchOn={route.matchOn || ''}
                        onChange={(next) => edits.setRoute({ matchOn: next })}
                        onConvert={edits.convertToConditions}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                )}

                <RouteRuleList
                    rules={rules}
                    several={several}
                    fanOut={fanOut}
                    items={items}
                    keepRest={!!route.keepRest}
                    valueStyle={valueStyle}
                    wiredCaseNames={wiredCaseNames}
                    outputName={edits.outputName}
                    onUpdate={edits.updateRule}
                    onMove={edits.moveRule}
                    onRemove={edits.removeRule}
                    onAdd={edits.addRule}
                    renderCondition={condition}
                />
            </AccordionSection>

            <AccordionSection stepType={step.type} sectionKey="advanced" title={t('automations.route_editors.advanced', 'Advanced')} forceOpen={errorSections.has('advanced')}>
                <RouteAdvancedFields
                    route={route}
                    rules={rules}
                    items={items}
                    several={several}
                    fanOut={fanOut}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    onPatch={edits.setRoute}
                    onChangeSource={edits.changeSource}
                />
            </AccordionSection>
        </>
    );
}

export { RouteFields };
