/**
 * What the Describe-it card cannot deliver, each in its own sentence — the
 * web's PlanCaveats (studioAi/DescribeItPanel.jsx):
 *
 *   - which kinds the server could not check, so the choice came from a
 *     shorter list than usual (a failure must not look like a confident plan);
 *   - that the proposed name does not travel along;
 *   - that the brief does not either, shown in full with a Copy button.
 *
 * The last two hold for every kind on the phone (model/describeIt.ts says
 * why), and only when the door is open: a locked kind has nothing to paste into.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import { kindWord, type DescribeItPlan } from '../model/describeIt';

export interface DescribeItCaveatsProps {
    plan: DescribeItPlan;
    /** "Make this" leads somewhere: only then is there a builder to paste into. */
    open: boolean;
}

export function DescribeItCaveats({ plan, open }: DescribeItCaveatsProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await Clipboard.setStringAsync(plan.seed);
            setCopied(true);
        } catch {
            // No clipboard: the brief is on screen, and selectable.
        }
    };
    return (
        <>
            {plan.undecided.length ? (
                <Text testID="studio-ai-undecided" variant="caption" tone="secondary">
                    {t(
                        'studio.ai.undecided_named',
                        'We could not check every building block just now ({kinds}), so this choice was made from a shorter list than usual.',
                        { kinds: plan.undecided.map((k) => kindWord(k, t)).join(', ') },
                    )}
                </Text>
            ) : null}
            {open && plan.name ? (
                <Text testID="studio-ai-name" variant="caption" tone="secondary">
                    {t('studio.ai.name_manual', 'The name does not travel along yet — give it this name in the builder that opens.')}
                </Text>
            ) : null}
            {open ? (
                <View testID="studio-ai-seed" style={styles.seed}>
                    <Text variant="caption" tone="secondary">
                        {t('studio.ai.seed_manual', 'Your description does not travel along yet — paste it into the assistant of the builder that opens.')}
                    </Text>
                    <Text testID="studio-ai-seed-text" variant="caption" selectable>
                        {plan.seed}
                    </Text>
                    <Button
                        size="sm"
                        variant="ghost"
                        iconName={copied ? 'Check' : 'Copy'}
                        label={copied ? t('studio.ai.copied', 'Copied') : t('studio.ai.copy', 'Copy description')}
                        onPress={() => void copy()}
                        style={styles.copy}
                        testID="studio-ai-copy"
                    />
                </View>
            ) : null}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    seed: {
        gap: theme.spacing[1],
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.sm,
        paddingHorizontal: theme.spacing[2.5],
        paddingVertical: theme.spacing[2],
    } satisfies ViewStyle,
    copy: { alignSelf: 'flex-start' } satisfies ViewStyle,
});
