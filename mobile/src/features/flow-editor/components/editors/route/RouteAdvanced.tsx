/**
 * The Condition node's Advanced band — what the author does not normally
 * touch (the web's RouteFields "Advanced"): whether it decides about each
 * item of a list or about the whole run (detected on wire, overridable here),
 * the list and its input cap, how several matching outputs share a record,
 * where unmatched values go, and the expressions the rules compile to.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput, FieldRow, NumberField, SelectField } from '@/features/flow-editor/components/fields';
import type { Route } from '@/features/flow-editor/model';
import { Text } from '@/shared/ui';

import type { RoutePatch } from './routeEdits';

export interface RouteAdvancedProps {
    route: Route;
    setRoute: (patch: RoutePatch) => void;
    /** A new list goes through the editor's list change (R11), not a bare patch. */
    onSource?: (source: string) => void;
    disabled?: boolean;
}

export function RouteAdvanced({ route, setRoute, onSource, disabled = false }: RouteAdvancedProps) {
    const t = useTranslation();
    const items = route.mode === 'items';
    const several = route.rules.length > 1;
    const expressions = route.rules.map((r) => r.expr).filter(Boolean);
    return (
        <>
            <SelectField
                label={t('automations.route_editors.deciding_about', 'Deciding about')}
                hint={t('automations.route_editors.detected_from_the_step_above_override', 'Detected from the step above — override it here if the guess is wrong.')}
                value={items ? 'items' : 'branch'}
                options={[
                    { value: 'items', label: t('automations.route_editors.each_item_of_a_list', 'Each item of a list') },
                    { value: 'branch', label: t('automations.route_editors.the_whole_run', 'The whole run') },
                ]}
                onChange={(v) => setRoute({ mode: v === 'items' ? 'items' : 'branch' })}
                disabled={disabled}
                testID="route-mode"
            />
            {items ? (
                <>
                    <BindingInput
                        mode="path"
                        list
                        required
                        value={route.source || ''}
                        onChange={(v) => (onSource ? onSource(String(v)) : setRoute({ source: String(v) }))}
                        label={t('automations.collection_editors.source_list', 'Source list')}
                        hint={t('automations.collection_editors.pick_a_list_from_a_previous', 'Pick a list from a previous step — or type a path manually.')}
                        prompt={t('automations.collection_editors.no_list_picked_yet', 'No list picked yet')}
                        disabled={disabled}
                        testID="route-source"
                    />
                    <NumberField
                        label={t('automations.collection_editors.max_input_items', 'Max input items')}
                        hint={t('automations.collection_editors.optional_cap_on_input_size_the', 'Optional cap on input size — the run FAILS if the source list is larger (platform cap 10 000). Leave blank for the default.')}
                        value={route.maxItems}
                        min={1}
                        max={10000}
                        integer
                        allowBlank
                        prompt="10000"
                        onChange={(maxItems) => setRoute({ maxItems })}
                        disabled={disabled}
                    />
                </>
            ) : null}
            {several ? (
                <SelectField
                    label={t('automations.route_editors.when_several_outputs_match', 'When several outputs match')}
                    hint={t('automations.route_editors.automations_built_before_this_existed_keep', 'Automations built before this existed keep sending each record down the first match only, until you change it here.')}
                    value={route.matchMode === 'all' ? 'all' : 'first'}
                    options={[
                        { value: 'all', label: t('automations.route_editors.send_it_to_every_matching_output', 'Send it to every matching output') },
                        { value: 'first', label: t('automations.route_editors.send_it_to_the_first_matching', 'Send it to the first matching output only') },
                    ]}
                    onChange={(v) => setRoute({ matchMode: v === 'all' ? 'all' : 'first' })}
                    disabled={disabled}
                />
            ) : null}
            {several ? (
                <SelectField
                    label={t('automations.route_editors.when_nothing_matches', 'When nothing matches')}
                    hint={t('mobile.flow.route.nothing_matches_hint', "Send unmatched values to one of your rules, or use the node's otherwise output.")}
                    value={route.defaultBranch || ''}
                    options={[
                        { value: '', label: t('condition_node.otherwise.use', 'Use the Otherwise output') },
                        ...route.rules.filter((r) => r.name).map((r) => ({ value: r.name, label: r.name })),
                    ]}
                    onChange={(defaultBranch) => setRoute({ defaultBranch })}
                    disabled={disabled}
                />
            ) : null}
            {expressions.length ? (
                <FieldRow label={t('automations.route_editors.expression', 'Expression')} hint={t('automations.route_editors.what_the_rules_above_compile_to', 'What the rules above compile to. Read-only — edit the rules to change it.')}>
                    {expressions.map((e, i) => (
                        <Text key={i} variant="code" tone="tertiary" selectable>
                            {e}
                        </Text>
                    ))}
                </FieldRow>
            ) : null}
        </>
    );
}
