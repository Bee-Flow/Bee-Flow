/**
 * The plan checklist the model keeps while it builds (the web's
 * BuilderPlanChecklist) — the live turn's, else the last one the session
 * saved.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import type { BuilderTodo } from '@/features/flow-editor/api';
import { Icon, Text } from '@/shared/ui';

import { makeSessionCardStyles } from './sessionCardStyles';

export function PlanCard({ todos }: { todos: readonly BuilderTodo[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeSessionCardStyles);
    if (!todos.length) return null;
    const done = todos.filter((x) => x.done).length;
    return (
        <View style={styles.card} testID="ai-plan">
            <View style={styles.head}>
                <Icon name="ListChecks" size={14} color={styles.open.color} />
                <Text variant="label" tone="tertiary">{t('mobile.flow.ai.plan', 'Plan · {done}/{total}', { done, total: todos.length }).toUpperCase()}</Text>
            </View>
            {todos.map((todo, i) => (
                <View key={`${i}-${todo.text}`} style={styles.todo}>
                    <Icon name={todo.done ? 'CircleCheck' : 'Circle'} size={14} color={todo.done ? styles.done.color : styles.open.color} />
                    <Text variant="caption" tone={todo.done ? 'tertiary' : 'primary'}>{todo.text}</Text>
                </View>
            ))}
        </View>
    );
}
