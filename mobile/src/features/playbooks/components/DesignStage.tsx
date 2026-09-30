/**
 * The design phase: the AI thinks about the app as a designer first —
 * screens, hierarchy, one accent — and the stage lays that out screen by
 * screen (the web draws wireframes; the phone lists each screen's sections
 * and the elements in them). Once it has landed the person can ask for a
 * change: the same phase redraws, and the app's brief follows the new design.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text, TextField } from '@/shared/ui';

import { StageCard } from './StageCard';
import { artList, artNum, artRecord, artRecords, textOf } from '../model/artifacts';
import type { PlaybookEvent } from '../model/phaseMachine';
import type { Phase, Playbook } from '../model/types';

const MAX_FEEDBACK = 800;

function ScreenSketch({ screen }: { screen: Record<string, unknown> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.screen} testID="playbook-design-screen">
            <Text variant="caption" weight="semibold">
                {textOf(screen, 'name')}
            </Text>
            {textOf(screen, 'purpose') ? (
                <Text variant="caption" tone="secondary">
                    {textOf(screen, 'purpose')}
                </Text>
            ) : null}
            {artRecords(screen, 'sections').map((section, i) => (
                <Text key={i} variant="label" tone="tertiary">
                    {[textOf(section, 'title'), artRecords(section, 'elements').map((e) => textOf(e, 'label')).filter(Boolean).join(' · ')]
                        .filter(Boolean)
                        .join(' — ')}
                </Text>
            ))}
        </View>
    );
}

function Revise({ phase, dispatch, revisions }: { phase: Phase; dispatch: (e: PlaybookEvent) => Promise<Playbook | null>; revisions: string[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [feedback, setFeedback] = useState('');
    const [revising, setRevising] = useState(false);
    const [failed, setFailed] = useState(false);
    const ask = async () => {
        const text = feedback.trim();
        if (!text || revising) return;
        setRevising(true);
        setFailed(false);
        const pb = await dispatch({ type: 'revise', key: phase.key, feedback: text });
        setRevising(false);
        if (pb) setFeedback('');
        else setFailed(true);
    };
    return (
        <View style={styles.revise} testID="playbook-design-revise">
            <TextField
                label={t('playbooks.design.revise_label', 'Ask for a change')}
                value={feedback}
                onChangeText={setFeedback}
                multiline
                maxLength={MAX_FEEDBACK}
                editable={!revising}
                placeholder={t('playbooks.design.revise_placeholder', 'Put the totals on top, give every supplier its own screen…')}
                hint={t('playbooks.design.revise_hint', 'The design is redrawn with your change — the app is built from what stands here.')}
                error={failed ? t('playbooks.design.revise_failed', 'The designer could not redraw it — try saying it in other words.') : null}
            />
            <Button
                size="sm"
                label={revising ? t('playbooks.design.revising', 'Redrawing…') : t('playbooks.design.revise_send', 'Redraw')}
                loading={revising}
                disabled={!feedback.trim()}
                onPress={() => void ask()}
                testID="playbook-design-revise-send"
            />
            {revisions.length ? (
                <Text variant="label" tone="tertiary">
                    {t('playbooks.design.revisions', 'You asked for: {list}', { list: revisions.join(' · ') })}
                </Text>
            ) : null}
        </View>
    );
}

export function DesignStage({ phase, dispatch }: { phase: Phase; dispatch: (e: PlaybookEvent) => Promise<Playbook | null> }) {
    const t = useTranslation();
    const a = phase.artifacts;
    const design = artRecord(a, 'design');
    const look = artRecord(design, 'look');
    const screens = artRecords(design, 'screens');
    const principles = (artList(design, 'principles') ?? []).filter((p): p is string => typeof p === 'string');
    const revisions = (artList(a, 'revisions') ?? []).filter((r): r is string => typeof r === 'string');
    const failed = phase.status === 'failed';
    const status = design
        ? t('playbooks.design.counts', '{screens} screens · {elements} elements', { screens: screens.length, elements: artNum(a, 'elementCount') ?? 0 })
        : failed
            ? t('playbooks.design.failed', 'The designer did not answer')
            : t('playbooks.design.thinking', 'The AI thinks about this app as a designer first — screens, hierarchy, one accent — before it knows a single building block.');
    return (
        <StageCard
            kind="app"
            title={design ? textOf(design, 'name') : t('playbooks.design.title', 'Designing the app')}
            subtitle={textOf(design, 'tagline') || null}
            status={status}
            tone={failed ? 'error' : design ? 'quiet' : 'busy'}
            testID="playbook-stage-design"
        >
            {look ? (
                <Text variant="caption" tone="secondary">
                    {t('playbooks.design.look_words', 'Look {preset}{mood}', { preset: textOf(look, 'preset'), mood: textOf(look, 'mood') ? ` · ${textOf(look, 'mood')}` : '' })}
                </Text>
            ) : null}
            {screens.map((screen, i) => <ScreenSketch key={`${revisions.length}:${i}`} screen={screen} />)}
            {design && phase.status === 'awaiting' ? <Revise phase={phase} dispatch={dispatch} revisions={revisions} /> : null}
            {principles.length ? (
                <Text variant="label" tone="tertiary">
                    {principles.join(' · ')}
                </Text>
            ) : null}
        </StageCard>
    );
}

const makeStyles = (theme: Theme) => ({
    screen: {
        gap: theme.spacing[1],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
    },
    revise: { gap: theme.spacing[2] },
});
