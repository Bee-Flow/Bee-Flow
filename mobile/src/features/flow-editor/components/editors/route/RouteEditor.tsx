/**
 * The unified Condition editor — one form for If, Switch and Filter (the
 * web's RouteFields, routeEditors.jsx). The form edits the unified route
 * (model/route/routeModel); saving picks the runtime type and heals the
 * node's connections, so the author only ever says what should happen:
 * how many outputs, and when each one is taken.
 *
 * In list mode a rule reads "Subject contains isv" about each ITEM: the rules
 * see a "Current item" group, and the field picker offers the item's fields.
 * "Suggest outputs" (RouteAssist) sits under the outputs chooser it pre-fills.
 *
 * Above the outputs it says what the node's list means for the steps around
 * it (SourceNotices): a next step that still reads the list this Condition
 * filters (W7), rules the new item cannot read after a list change (R11), and
 * a whole-run Condition that reads a list as a whole (BFSF-485 F3/F4) — each
 * with its one-tap fix.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { resolveElementSample } from '@/features/flow-editor/bindings';
import { followedWords } from '@/features/flow-editor/components/build/useOutlineEditing';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { VariablePickerProvider } from '@/features/flow-editor/components/variables';
import { buildStepTypeMap, readRoute, type Route } from '@/features/flow-editor/model';
import { Button, Text, useToast } from '@/shared/ui';

import { Band } from '../shared/Band';
import { Note } from '../shared/Note';
import { SourceSummary } from '../shared/SourceSummary';
import type { StepEditorProps } from '../types';
import { configuredRules, fansOutAfterAccept, sampleRowsFor } from './assistModel';
import { itemFieldOptions, itemScope, upstreamFieldOptions } from './fieldOptions';
import { otherwiseSentence, OutputsChooser } from './OutputsChooser';
import { RouteAdvanced } from './RouteAdvanced';
import { RouteAssist } from './RouteAssist';
import { applySuggestion, convertToConditions, wiredCaseNames, type RoutePatch } from './routeEdits';
import { staleSteps, wholeRunReads } from './routeNotices';
import { fieldNameOf, itemNameOf, rulesForSource, withoutRowsReading, workThroughList } from './routeSourceEdits';
import { RuleList } from './RuleList';
import { StaleNotice, UnfitNotice, WholeListNotice } from './SourceNotices';

function useRouteScope(editor: StepEditorProps, route: Route) {
    const t = useTranslation();
    const { ctx } = editor;
    const items = route.mode === 'items';
    const element = items ? resolveElementSample(route.source, ctx.sampleRoot) : null;
    const scope = items ? itemScope(element, ctx, t('mobile.flow.route.current_item', 'Current item')) : null;
    const options = items ? itemFieldOptions(element, itemNameOf(route.source), t) : upstreamFieldOptions(ctx.groups, t);
    return { element, scope, options };
}

function RuleHeader({ route, setRoute, disabled }: { route: Route; setRoute: (p: RoutePatch) => void; disabled: boolean }) {
    const t = useTranslation();
    const several = route.rules.length > 1;
    const items = route.mode === 'items';
    const fanOut = route.matchMode === 'all';
    const label = several ? t('mobile.flow.route.conditions_per_output', 'Conditions per output') : items ? t('mobile.flow.route.keep_when', 'Keep when') : t('mobile.flow.route.continue_when', 'Continue when');
    const hint = several
        ? fanOut
            ? t('mobile.flow.route.per_output_all', 'Each output has its own condition set and is checked independently — {unit} can match several.', { unit: items ? t('mobile.flow.route.an_item', 'an item') : t('mobile.flow.route.a_record', 'a record') })
            : t('mobile.flow.route.per_output_first', 'Each output has its own condition set, checked in order — the first match wins.')
        : items
          ? otherwiseSentence(t, { several: false, fanOut, keepRest: !!route.keepRest, items: true })
          : t('mobile.flow.route.continue_when_hint', 'The run continues when this is true.');
    return (
        <>
            {route.style === 'value' ? (
                <>
                    <BindingInput
                        mode="path"
                        value={route.matchOn || ''}
                        onChange={(v) => setRoute({ matchOn: String(v) })}
                        label={t('automations.route_editors.value_to_check', 'Value to check')}
                        hint={t('mobile.flow.route.value_to_check_hint', "Picked once; matched against each rule's value below.")}
                        prompt={t('mobile.flow.route.value_to_check_prompt', 'Tap Insert data to pick the value')}
                        disabled={disabled}
                    />
                    <Button size="sm" variant="ghost" label={t('automations.route_editors.use_full_conditions_instead', 'Use full conditions instead')} onPress={() => setRoute(convertToConditions(route))} disabled={disabled} />
                </>
            ) : null}
            <Text variant="caption" weight="medium" tone="secondary">
                {label}
            </Text>
            <Note>{hint}</Note>
        </>
    );
}

/** The list the node works through, and what a change of it does to the rules (R11). */
function useSourceChange(editor: StepEditorProps, route: Route, setRoute: (p: RoutePatch) => void) {
    const t = useTranslation();
    const [unfit, setUnfit] = useState<{ paths: string[]; itemName: string } | null>(null);
    const change = (next: string) => {
        const element = resolveElementSample(next, editor.ctx.sampleRoot);
        const moved = rulesForSource(route.rules, route.source || '', next || '', element);
        setRoute({ source: next, rules: moved.rules });
        setUnfit(moved.unfit.length ? { paths: moved.unfit, itemName: itemNameOf(next) } : null);
    };
    const removeUnfit = () => {
        setRoute({ rules: withoutRowsReading(route.rules, unfit?.paths ?? []) });
        setUnfit(null);
    };
    const fields = (unfit?.paths ?? []).map((p) => fieldNameOf(p, t));
    return { change, removeUnfit, fields, itemName: unfit?.itemName ?? 'item' };
}

/** The notices above the outputs (W7, R11, F3/F4). */
function RouteNotices({ editor, route, setRoute, source }: { editor: StepEditorProps; route: Route; setRoute: (p: RoutePatch) => void; source: ReturnType<typeof useSourceChange> }) {
    const t = useTranslation();
    const { toast } = useToast();
    const { step, ctx } = editor;
    const items = route.mode === 'items';
    const follow = ctx.followRoute;
    const stale = items && follow ? staleSteps(ctx.definition, step.id, t) : [];
    const onFollow = (stepIds: string[]) => {
        const rebound = follow?.(step.id, stepIds);
        if (rebound) for (const words of followedWords(ctx.definition, rebound, t)) toast(words, 'success');
    };
    const convert = (list: string) => {
        const patch = workThroughList(route.rules, list);
        if (patch) setRoute(patch);
    };
    const whole = items ? null : wholeRunReads({ step, route, definition: ctx.definition, sampleRoot: ctx.sampleRoot }, t);
    return (
        <>
            <StaleNotice stale={stale} onFollow={onFollow} disabled={ctx.disabled} />
            {items ? <UnfitNotice fields={source.fields} itemName={source.itemName} onRemove={source.removeUnfit} disabled={ctx.disabled} /> : null}
            <WholeListNotice reads={whole} onConvert={(list) => convert(list)} disabled={ctx.disabled} />
        </>
    );
}

export function RouteEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { step, draft, set, ctx } = editor;
    const route = (draft.route as Route | undefined) ?? readRoute(step);
    const setRoute = (patch: RoutePatch) => set('route', { ...route, ...patch });
    const wired = wiredCaseNames(ctx.definition.edges, step.id);
    const { element, scope, options } = useRouteScope(editor, route);
    const source = useSourceChange(editor, route, setRoute);
    const items = route.mode === 'items';
    const several = route.rules.length > 1;
    const rules = (
        <RuleList route={route} wired={wired} setRoute={setRoute} fieldOptions={options} sampleRoot={scope?.sampleRoot ?? ctx.sampleRoot} simple={ctx.mode === 'simple'} disabled={ctx.disabled} />
    );
    return (
        <>
            {items ? (
                <SourceSummary
                    hint={t('automations.route_editors.detected_from_the_step_above_each', 'Detected from the step above. Each item is checked against the rules below.')}
                    source={route.source}
                    maxItems={route.maxItems}
                    onSource={source.change}
                    onMaxItems={(maxItems) => setRoute({ maxItems })}
                    groups={ctx.groups}
                    sampleRoot={ctx.sampleRoot}
                    stepLabelById={ctx.stepLabelById}
                    stepTypeById={buildStepTypeMap(ctx.definition)}
                    disabled={ctx.disabled}
                />
            ) : null}
            <RouteNotices editor={editor} route={route} setRoute={setRoute} source={source} />
            <Band editor={editor} sectionKey="rules" title={several ? t('mobile.flow.route.outputs', 'Outputs') : t('automations.ndv.output', 'Output')} defaultOpen>
                <OutputsChooser route={route} wired={wired} setRoute={setRoute} disabled={ctx.disabled} />
                {route.style !== 'value' ? (
                    <RouteAssist
                        fields={options}
                        sampleRows={sampleRowsFor(route, ctx.sampleRoot)}
                        sampleRoot={scope?.sampleRoot ?? ctx.sampleRoot}
                        unit={route.mode === 'items' ? 'items' : 'records'}
                        sourceRef={items ? route.source : ''}
                        itemSample={items ? element : null}
                        onWorkThroughList={items ? source.change : null}
                        existing={configuredRules(route)}
                        fanOut={fansOutAfterAccept(route)}
                        keepRest={items && !!route.keepRest}
                        wiredNames={route.rules.map((r) => r.name).filter((n) => !!n && wired.has(n))}
                        onApply={(suggested) => setRoute(applySuggestion(route, suggested))}
                        disabled={ctx.disabled}
                    />
                ) : null}
                <RuleHeader route={route} setRoute={setRoute} disabled={ctx.disabled} />
                {scope ? (
                    <VariablePickerProvider groups={scope.groups} sampleRoot={scope.sampleRoot} stepLabelById={ctx.stepLabelById}>
                        {rules}
                    </VariablePickerProvider>
                ) : (
                    rules
                )}
            </Band>
            <Band editor={editor} sectionKey="advanced" title={t('mobile.flow.section.advanced', 'Advanced')}>
                <RouteAdvanced route={route} setRoute={setRoute} onSource={source.change} disabled={ctx.disabled} />
            </Band>
        </>
    );
}
