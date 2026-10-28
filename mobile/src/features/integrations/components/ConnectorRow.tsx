/** One linkable account: its state, who it is linked as, and what you can do with it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { ConnectorActions } from './ConnectorActions';
import { ConnectorBadge } from './ConnectorBadge';
import type { Connector } from '../model/catalog';
import { connectorState } from '../model/connectorState';
import type { IntegrationStatus } from '../model/types';

export function ConnectorRow({
    connector,
    status,
    loading,
    busy,
    onConnect,
    onDisconnect,
}: {
    connector: Connector;
    status: IntegrationStatus | null;
    loading: boolean;
    busy: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const state = connectorState(connector, status);
    const label = t(connector.label.i18nKey, connector.label.en);

    return (
        <View style={styles.row}>
            <View style={styles.header}>
                <View style={styles.text}>
                    <View style={styles.title}>
                        <Text variant="body" weight="medium">
                            {label}
                        </Text>
                        {loading ? null : (
                            <ConnectorBadge
                                needsReauth={state.needsReauth}
                                connected={state.connected}
                                notConfigured={state.notConfigured}
                            />
                        )}
                    </View>
                    <Text variant="caption" tone="tertiary">
                        {state.identity ?? t(connector.description.i18nKey, connector.description.en)}
                    </Text>
                </View>
                <Icon
                    name={state.connected ? 'CircleCheckBig' : 'Circle'}
                    size={18}
                    color={state.connected ? theme.colors.success : theme.colors.textMuted}
                />
            </View>
            <ConnectorActions
                state={state}
                busy={busy}
                label={label}
                connectsHere={connector.flow !== 'oauth'}
                onConnect={onConnect}
                onDisconnect={onDisconnect}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            gap: theme.spacing.sm,
        },
        header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
        text: { flex: 1, gap: 2 },
        title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    });
