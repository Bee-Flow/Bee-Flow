/**
 * The way into the editors from an agent's profile — only for someone the
 * server lets edit this agent (model/permissions.ts). Editing itself lives on
 * its own screens; the profile stays what the agent is for.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/ui';

import { canEditAgent } from '../model/permissions';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ row: { flexDirection: 'row', gap: theme.spacing.sm }, button: { flex: 1 } });

export function ProfileEditActions({ agent }: { agent: Agent }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const manage = useHasPermission('manage_agents');
    if (!canEditAgent(agent, manage)) return null;
    return (
        <View style={styles.row}>
            <Button
                label={t('common.edit', 'Edit')}
                iconName="PenLine"
                variant="secondary"
                style={styles.button}
                onPress={() => router.push(`/agents/${agent.id}/edit`)}
            />
            <Button
                label={t('mobile.agents.edit_with_ai', 'Edit with AI')}
                iconName="Sparkles"
                variant="secondary"
                style={styles.button}
                onPress={() => router.push(`/agents/${agent.id}/refine`)}
            />
        </View>
    );
}
