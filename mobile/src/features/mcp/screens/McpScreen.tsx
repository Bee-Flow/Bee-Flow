/**
 * MCP — the two directions, kept apart.
 *
 * Bee Flow sits on both sides of the Model Context Protocol and the two are
 * unrelated surfaces with adjacent names, so this screen never merges them:
 * OUTBOUND, the servers Bee Flow calls (ServersSection); INBOUND, Bee Flow
 * served as an MCP server with a per-user token (TokenSection).
 *
 * The token is the reason this screen is worth having on a phone at all: it is
 * shown exactly once, minting a new one revokes the old one, and the sheet
 * that shows it cannot be dismissed by reflex (see SecretOnce).
 */

import React from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Screen, ScreenHeader } from '@/shared/ui';

import { ServersSection } from '../components/ServersSection';
import { TokenSection } from '../components/TokenSection';
import { TokenSheets } from '../components/TokenSheets';
import { useMcpServers, useMcpToken } from '../hooks/queries';
import { useTokenFlow } from '../hooks/useTokenFlow';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
    });

export function McpScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const token = useMcpToken();
    const servers = useMcpServers();
    const refresh = useUserRefresh(() => Promise.all([token.refetch(), servers.refetch()]));
    const flow = useTokenFlow();

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="MCP" subtitle="Model Context Protocol" />
            <ScrollView
                contentContainerStyle={styles.content}
                refreshControl={
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <TokenSection token={token} flow={flow} />
                <ServersSection servers={servers} />
            </ScrollView>
            <TokenSheets flow={flow} />
        </Screen>
    );
}
