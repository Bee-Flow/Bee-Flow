/**
 * One step of a skill's method — the web's SkillStepEditor card.
 *
 * The number is the step's place, not typed text, so it can never go wrong.
 * References FLOW after the sentence as pills: S1 stores them as a list beside
 * the text, not inside it. Reordering is two buttons rather than a drag — a
 * drag handle fights the text field for the same finger on a phone, and the
 * buttons are what TalkBack can operate anyway.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { ActionMenu, Card, Chip, Icon, IconButton, Text, TextField, tint, kindColor, kindOf } from '@/shared/ui';

import { GrantPill } from './GrantPill';
import { REF_ICON, refMenuItems } from './refMenu';
import { pickerName, type PickerData } from '../hooks/usePickerData';
import { refKindKey } from '../model/skillModel';
import { refHref } from '../model/testRun';
import type { SkillStep, StepRef } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: { gap: theme.spacing.sm },
        head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        badge: {
            width: 24,
            height: 24,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tint(kindColor(theme, kindOf('skill')), 14),
        },
        badgeInk: { color: kindColor(theme, kindOf('skill')) },
        grow: { flex: 1 },
        pills: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs },
    });

export interface StepCardProps {
    step: SkillStep;
    index: number;
    count: number;
    readOnly: boolean;
    picker: PickerData;
    onChange: (step: SkillStep) => void;
    onMove: (to: number) => void;
    onRemove: () => void;
}

function listOf(ref: StepRef, picker: PickerData) {
    return ref.kind === 'automation' ? picker.routines : ref.kind === 'kb' ? picker.kbs : picker.tables;
}

function StepRefs({ step, readOnly, picker, onChange }: Pick<StepCardProps, 'step' | 'readOnly' | 'picker' | 'onChange'>) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const [adding, setAdding] = useState(false);
    const drop = (ref: StepRef) => onChange({ ...step, refs: step.refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) });
    const add = (ref: StepRef) => {
        setAdding(false);
        onChange({ ...step, refs: [...step.refs, ref] });
    };
    if (readOnly && step.refs.length === 0) return null;
    return (
        <View style={styles.pills}>
            {step.refs.map((ref) => {
                const href = refHref(ref);
                return (
                    <GrantPill
                        key={`${ref.kind}:${ref.id}`}
                        label={pickerName(listOf(ref, picker), ref.id)}
                        icon={REF_ICON[ref.kind]}
                        kind={refKindKey(ref.kind) ?? 'kb'}
                        onOpen={href ? () => openRoute(router, href) : undefined}
                        onRemove={readOnly ? undefined : () => drop(ref)}
                        removeLabel={t('skills_studio.steps.ref_remove', 'Remove reference')}
                    />
                );
            })}
            {readOnly ? null : (
                <Chip label={t('skills_studio.steps.ref_add', 'reference')} icon={<Icon name="Plus" size={14} />} onPress={() => setAdding(true)} />
            )}
            <ActionMenu
                visible={adding}
                onClose={() => setAdding(false)}
                title={t('skills_studio.steps.ref_add', 'reference')}
                items={refMenuItems(t, picker, step.refs, add)}
            />
        </View>
    );
}

function StepActions({ index, count, onMove, onRemove }: Pick<StepCardProps, 'index' | 'count' | 'onMove' | 'onRemove'>) {
    const t = useTranslation();
    const theme = useTheme();
    const ink = theme.colors.textTertiary;
    return (
        <>
            <IconButton
                icon={<Icon name="ChevronUp" size={18} color={ink} />}
                accessibilityLabel={t('mobile.skills.move_up', 'Move up')}
                disabled={index === 0}
                onPress={() => onMove(index - 1)}
            />
            <IconButton
                icon={<Icon name="ChevronDown" size={18} color={ink} />}
                accessibilityLabel={t('mobile.skills.move_down', 'Move down')}
                disabled={index === count - 1}
                onPress={() => onMove(index + 1)}
            />
            <IconButton
                icon={<Icon name="Trash2" size={18} color={ink} />}
                accessibilityLabel={t('skills_studio.steps.remove', 'Remove step')}
                onPress={onRemove}
            />
        </>
    );
}

export function StepCard(p: StepCardProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card style={styles.card} testID="skill-step">
            <View style={styles.head}>
                <View style={styles.badge}>
                    <Text variant="label" weight="bold" style={styles.badgeInk}>
                        {String(p.index + 1)}
                    </Text>
                </View>
                <View style={styles.grow} />
                {p.readOnly ? null : <StepActions index={p.index} count={p.count} onMove={p.onMove} onRemove={p.onRemove} />}
            </View>
            <TextField
                accessibilityLabel={t('skills_studio.steps.step_n', 'Step {n}', { n: p.index + 1 })}
                value={p.step.text}
                onChangeText={(text) => p.onChange({ ...p.step, text })}
                placeholder={t('skills_studio.steps.placeholder', 'What happens in this step?')}
                editable={!p.readOnly}
                multiline
                maxLines={6}
            />
            <StepRefs step={p.step} readOnly={p.readOnly} picker={p.picker} onChange={p.onChange} />
        </Card>
    );
}
