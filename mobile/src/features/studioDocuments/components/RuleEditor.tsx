/**
 * When a section applies, at any depth — the web's recursive `Rule` editor
 * (DocumentWorkspacePanel.jsx). A condition is a rule (a parameter, a
 * comparison and, except for "is set", a value of the parameter's type) or a
 * group of conditions joined by all or any; "+ Group" nests one more level
 * while depth < 4, as on the web. The edits are model/conditionOps.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Button, FilterPills, Segmented } from '@/shared/ui';

import { makeEditorStyles } from './editorStyles';
import { TypedValueField, YesNoPicker } from './ParamFields';
import {
    addGroup,
    addRule,
    childrenOf,
    isGroup,
    joinOf,
    MAX_GROUP_DEPTH,
    newCondition,
    removeChild,
    setChild,
    setJoin,
    type Group,
    type Join,
} from '../model/conditionOps';
import { operatorLabel } from '../model/format';
import { OPERATORS, type Condition, type ContractParameter, type Rule } from '../model/types';
import { ruleFor } from '../model/values';

function ValuePicker({ rule, parameter, onChange }: { rule: Rule; parameter: ContractParameter | undefined; onChange: (value: unknown) => void }) {
    const t = useTranslation();
    const label = t('mobile.studio_documents.rule.value', 'Value');
    if (rule.operator === 'is_set') return null;
    if (parameter?.type === 'boolean') return <YesNoPicker label={label} value={rule.value} onChange={onChange} />;
    if (parameter?.type === 'choice' && parameter.options?.length) {
        return (
            <FilterPills
                value={typeof rule.value === 'string' ? rule.value : ''}
                onChange={onChange}
                options={parameter.options.map((o) => ({ value: o, label: o }))}
                accessibilityLabel={label}
            />
        );
    }
    const type = parameter?.type === 'number' || parameter?.type === 'date' ? parameter.type : 'text';
    return <TypedValueField key={`${rule.parameter}:${type}`} type={type} label={label} value={rule.value} onChange={onChange} />;
}

function RuleCard({ rule, parameters, onChange }: { rule: Rule; parameters: ContractParameter[]; onChange: (next: Rule) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    const parameter = parameters.find((p) => p.key === rule.parameter);
    return (
        <View style={styles.card}>
            <FilterPills
                value={rule.parameter}
                onChange={(key) => onChange(ruleFor(parameters.find((p) => p.key === key), rule.operator))}
                options={parameters.map((p) => ({ value: p.key, label: p.label || p.key }))}
                accessibilityLabel={t('mobile.studio_documents.rule.parameter', 'Condition parameter')}
            />
            <FilterPills
                value={rule.operator}
                onChange={(operator) => onChange({ ...rule, operator })}
                options={OPERATORS.map((op) => ({ value: op, label: operatorLabel(t, op) }))}
                accessibilityLabel={t('mobile.studio_documents.rule.comparison', 'Comparison')}
            />
            <ValuePicker rule={rule} parameter={parameter} onChange={(value) => onChange({ ...rule, value })} />
        </View>
    );
}

function GroupEditor({ group, parameters, onChange, depth }: { group: Group; parameters: ContractParameter[]; onChange: (next: Condition | null) => void; depth: number }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    const first = ruleFor(parameters[0]);
    return (
        <View style={depth > 0 ? styles.rail : styles.block}>
            <Segmented<Join>
                options={[
                    { value: 'all', label: t('mobile.studio_documents.rule.all', 'All conditions') },
                    { value: 'any', label: t('mobile.studio_documents.rule.any', 'Any condition') },
                ]}
                value={joinOf(group)}
                onChange={(join) => onChange(setJoin(group, join))}
                accessibilityLabel={t('mobile.studio_documents.rule.group', 'Condition group')}
                fullWidth
            />
            {childrenOf(group).map((child, index) => (
                <View key={index} style={styles.block}>
                    <RuleEditor value={child} parameters={parameters} depth={depth + 1} onChange={(next) => onChange(setChild(group, index, next))} />
                    <Button label={t('automations.condition_builder_row.remove_condition', 'Remove condition')} onPress={() => onChange(removeChild(group, index))} variant="ghost" size="sm" />
                </View>
            ))}
            <View style={styles.actions}>
                <Button label={t('mobile.studio_documents.rule.add_rule', 'Rule')} iconName="Plus" variant="secondary" size="sm" disabled={!parameters.length} onPress={() => onChange(addRule(group, first))} />
                {depth < MAX_GROUP_DEPTH ? (
                    <Button label={t('mobile.studio_documents.rule.add_group', 'Group')} iconName="Plus" variant="secondary" size="sm" disabled={!parameters.length} onPress={() => onChange(addGroup(group, first))} />
                ) : null}
            </View>
        </View>
    );
}

export interface RuleEditorProps {
    value: Condition | null;
    parameters: ContractParameter[];
    onChange: (next: Condition | null) => void;
    depth?: number;
}

export function RuleEditor({ value, parameters, onChange, depth = 0 }: RuleEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    if (!value) {
        return (
            <Button
                label={t('automations.condition_builder.add_condition', 'Add condition')}
                iconName="Plus"
                variant="secondary"
                disabled={!parameters.length}
                onPress={() => onChange(newCondition(ruleFor(parameters[0])))}
            />
        );
    }
    if (isGroup(value)) return <GroupEditor group={value} parameters={parameters} onChange={onChange} depth={depth} />;
    if (depth > 0) return <RuleCard rule={value} parameters={parameters} onChange={onChange} />;
    // A bare rule at the top (an older contract, or one an AI wrote): editable,
    // and removable, which inside a group is the group's button.
    return (
        <View style={styles.block}>
            <RuleCard rule={value} parameters={parameters} onChange={onChange} />
            <Button label={t('automations.condition_builder_row.remove_condition', 'Remove condition')} onPress={() => onChange(null)} variant="ghost" size="sm" />
        </View>
    );
}
