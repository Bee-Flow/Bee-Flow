/**
 * The outputs themselves — the web's rule rows (routeEditors.jsx): with one
 * output just its condition; with several, each output is a card with its
 * letter, its name (which becomes the connection's label), whether it is
 * wired on the canvas, and its own conditions. A legacy value-matching switch
 * keeps its per-output values until it is converted to full conditions.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { Route } from '@/features/flow-editor/model';
import { TextField } from '@/shared/ui';

import { CaseNameInput } from './CaseNameInput';
import { ConditionBuilder } from './ConditionBuilder';
import { outputNamer } from './OutputsChooser';
import { addRule, removeRule, updateRule, type RoutePatch } from './routeEdits';
import { AddButton } from '../shared/AddButton';
import type { PickOption } from '../shared/FieldPicker';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';

export interface RuleListProps {
    route: Route;
    wired: ReadonlySet<string>;
    setRoute: (patch: RoutePatch) => void;
    fieldOptions: readonly PickOption[];
    sampleRoot: unknown;
    /** Simple mode: a formula the rows cannot show reads as a "Custom rule" card. */
    simple?: boolean;
    disabled?: boolean;
}

function RuleBody({ props, i }: { props: RuleListProps; i: number }) {
    const t = useTranslation();
    const { route, setRoute } = props;
    const rule = route.rules[i];
    if (!rule) return null;
    if (route.style === 'value') {
        return (
            <TextField
                label={t('mobile.flow.route.value_to_match', 'Value to match')}
                value={typeof rule.value === 'string' ? rule.value : rule.value == null ? '' : String(rule.value)}
                onChangeText={(value) => setRoute(updateRule(route, i, { value }))}
                editable={!props.disabled}
            />
        );
    }
    const items = route.mode === 'items';
    return (
        <ConditionBuilder
            value={rule.expr || ''}
            onChange={(expr) => setRoute(updateRule(route, i, { expr }))}
            sampleRoot={props.sampleRoot}
            context={items ? 'filter' : 'condition'}
            fieldOptions={props.fieldOptions}
            fieldBase={items ? 'item' : 'trigger.output'}
            simple={props.simple}
            disabled={props.disabled}
        />
    );
}

export function RuleList(props: RuleListProps) {
    const t = useTranslation();
    const { route, wired, setRoute, disabled = false } = props;
    const rules = route.rules;
    const several = rules.length > 1;
    return (
        <>
            {rules.length === 0 ? <Note>{t('mobile.flow.route.no_outputs', 'No outputs yet — add one.')}</Note> : null}
            {rules.map((rule, i) =>
                several ? (
                    <RowCard
                        key={i}
                        title={outputNamer(t)(i + 1)}
                        onRemove={() => setRoute(removeRule(route, i))}
                        removeLabel={
                            wired.has(rule.name)
                                ? t('mobile.flow.route.remove_wired', 'Remove output — its canvas connection will be removed too')
                                : t('mobile.flow.route.remove', 'Remove output')
                        }
                        disabled={disabled}
                        testID={`route-output-${i + 1}`}
                    >
                        <CaseNameInput
                            name={rule.name || ''}
                            siblingNames={rules.filter((_, j) => j !== i).map((r) => r.name).filter(Boolean)}
                            onCommit={(name) => setRoute(updateRule(route, i, { name }))}
                            disabled={disabled}
                            testID={`route-output-${i + 1}-name`}
                        />
                        {wired.has(rule.name) ? <Note>{t('mobile.flow.route.wired', 'Wired on the canvas — renaming keeps the connection; removing drops it.')}</Note> : null}
                        <RuleBody props={props} i={i} />
                    </RowCard>
                ) : (
                    <RuleBody key={i} props={props} i={i} />
                ),
            )}
            <AddButton label={t('mobile.flow.route.add_output', 'Add output')} onPress={() => setRoute(addRule(route, outputNamer(t)))} disabled={disabled} testID="route-add-output" />
            <Note>{t('condition_node.hint.case', 'Text comparisons ignore upper/lower case.')}</Note>
        </>
    );
}
