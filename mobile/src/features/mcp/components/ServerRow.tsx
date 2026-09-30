/** One configured MCP server: its health, its tools, and a re-check. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AppIcon, Badge, ListRow, Text } from '@/shared/ui';

import { mcpStatus, mcpSubtitle } from '../model/format';
import type { McpServer } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        icon: {
            width: 36,
            height: 36,
            borderRadius: theme.radii.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
        },
        error: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    });

export function ServerRow({ server }: { server: McpServer }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const status = mcpStatus(server);

    return (
        <View>
            <ListRow
                title={server.name}
                subtitle={mcpSubtitle(server)}
                meta={server.updatedAt ? timeAgo(server.updatedAt) : undefined}
                wrapTitle
                leading={
                    <View style={styles.icon}>
                        <AppIcon name={server.icon} fallback="Share2" size={16} color={theme.colors.textPrimary} />
                    </View>
                }
                trailing={<Badge label={status.label} tone={status.tone} />}
            />
            {server.error ? (
                <Text variant="caption" tone="error" style={styles.error} numberOfLines={3}>
                    {server.error}
                </Text>
            ) : null}
        </View>
    );
}
