/**
 * The steps inside the loop, in the order they run for each item (the
 * engine chains them top to bottom). Each opens in its own step editor by
 * its address (`loop_1/ai_2`); adding, removing and moving them is the
 * outline's job, where the loop's body is an indented lane.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { stepTypeLabel } from '@/features/flow-editor/components/nodeEditor/headerText';
import { stepIconName } from '@/features/flow-editor/components/outline/stepIcons';
import { stepEditorPath } from '@/features/flow-editor/components/outline/stepRoute';
import type { FlowStep } from '@/features/flow-editor/model';
import { bodyOf, childAddress } from '@/features/flow-editor/model/outline';
import { Icon, ListRow } from '@/shared/ui';

import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

export function LoopBodyList({ step, ctx }: StepEditorProps) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const body = bodyOf(step as FlowStep);
    const address = ctx.stepAddress ?? String(step.id);
    if (!body.length) {
        return <Note>{t('mobile.flow.loop.body_empty', 'No steps inside the loop yet — add them under the loop in the outline.')}</Note>;
    }
    return (
        <View style={styles.list}>
            {body.map((s, i) => (
                <ListRow
                    key={s.id}
                    title={s.label || stepTypeLabel(s, t)}
                    subtitle={`${i + 1} · ${stepTypeLabel(s, t)}`}
                    leading={<Icon name={stepIconName(s)} size={18} color={styles.glyph.color} />}
                    chevron
                    onPress={() => router.push(stepEditorPath(ctx.flowKey, childAddress(address, s.id), null, ctx.flowlet))}
                    testID={`loop-body-${s.id}`}
                />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { marginHorizontal: -theme.spacing.md } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});
