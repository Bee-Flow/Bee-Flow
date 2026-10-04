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
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { resolveElementSample } from '@/features/flow-editor/bindings';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { VariablePickerProvider } from '@/features/flow-editor/components/variables';
import { readRoute, type Route } from '@/features/flow-editor/model';
import { Button, Text } from '@/shared/ui';

import { Band } from '../shared/Band';
import { Note } from '../shared/Note';
import { SourceSummary } from '../shared/SourceSummary';
import type { StepEditorProps } from '../types';
import { configuredRules, sampleRowsFor } from './assistModel';
import { itemFieldOptions, itemScope, upstreamFieldOptions } from './fieldOptions';
import { OutputsChooser } from './OutputsChooser';
import { RouteAdvanced } from './RouteAdvanced';
import { RouteAssist } from './RouteAssist';
import { applySuggestion, convertToConditions, wiredCaseNames, type RoutePatch } from './routeEdits';
import { RuleList } from './RuleList';

function useRouteScope(editor: StepEditorProps, route: Route) {
    const t = useTranslation();
    const { ctx } = editor;
    const items = route.mode === 'items';
    const element = items ? resolveElementSample(route.source, ctx.sampleRoot) : null;
    const scope = items ? itemScope(element, ctx, t('mobile.flow.route.current_item', 'Current item')) : null;
    const options = items ? itemFieldOptions(element, t('automations.builder.fields_of_items', 'Fields of each item')) : upstreamFieldOptions(ctx.groups);
    return { scope, options };
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
          ? t('mobile.flow.route.keep_when_hint', 'Every item is checked against this condition. Items that do not match stop here.')
          : t('mobile.flow.route.continue_when_hint', 'The run continues when this is true.');
    return (
        <>
            {route.style === 'value' ? (
                <>
                    <BindingInput
                        mode="path"
                        value={route.matchOn || ''}
                        onChange={(v) => setRoute({ matchOn: String(v) })}
                        label={t('mobile.flow.route.value_to_check', 'Value to check')}
                        hint={t('mobile.flow.route.value_to_check_hint', "Picked once; matched against each rule's value below.")}
                        prompt={t('mobile.flow.route.value_to_check_prompt', 'Tap Insert data to pick the value')}
                        disabled={disabled}
                    />
                    <Button size="sm" variant="ghost" label={t('mobile.flow.route.use_full_conditions', 'Use full conditions instead')} onPress={() => setRoute(convertToConditions(route))} disabled={disabled} />
                </>
            ) : null}
            <Text variant="caption" weight="medium" tone="secondary">
                {label}
            </Text>
            <Note>{hint}</Note>
        </>
    );
}

export function RouteEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { step, draft, set, ctx } = editor;
    const route = (draft.route as Route | undefined) ?? readRoute(step);
    const setRoute = (patch: RoutePatch) => set('route', { ...route, ...patch });
    const wired = wiredCaseNames(ctx.definition.edges, step.id);
    const { scope, options } = useRouteScope(editor, route);
    const several = route.rules.length > 1;
    const rules = (
        <RuleList route={route} wired={wired} setRoute={setRoute} fieldOptions={options} sampleRoot={scope?.sampleRoot ?? ctx.sampleRoot} disabled={ctx.disabled} />
    );
    return (
        <>
            {route.mode === 'items' ? (
                <SourceSummary
                    hint={t('mobile.flow.route.source_hint', 'Detected from the step above. Each item is checked against the rules below.')}
                    source={route.source}
                    maxItems={route.maxItems}
                    onSource={(source) => setRoute({ source })}
                    onMaxItems={(maxItems) => setRoute({ maxItems })}
                    groups={ctx.groups}
                    sampleRoot={ctx.sampleRoot}
                    disabled={ctx.disabled}
                />
            ) : null}
            <Band editor={editor} sectionKey="rules" title={several ? t('mobile.flow.route.outputs', 'Outputs') : t('automations.ndv.output', 'Output')} defaultOpen>
                <OutputsChooser route={route} wired={wired} setRoute={setRoute} disabled={ctx.disabled} />
                {route.style !== 'value' ? (
                    <RouteAssist
                        fields={options}
                        sampleRows={sampleRowsFor(route, ctx.sampleRoot)}
                        sampleRoot={scope?.sampleRoot ?? ctx.sampleRoot}
                        unit={route.mode === 'items' ? 'items' : 'records'}
                        existing={configuredRules(route)}
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
                <RouteAdvanced route={route} setRoute={setRoute} disabled={ctx.disabled} />
            </Band>
        </>
    );
}
