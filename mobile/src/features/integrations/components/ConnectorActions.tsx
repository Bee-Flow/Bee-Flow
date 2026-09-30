/**
 * The one thing a connector row lets you do: disconnect, reconnect, connect —
 * or, when no administrator has configured the provider, read who has to act.
 *
 * An OAuth provider (Google, Microsoft, LinkedIn, Withings) cannot be connected
 * from the phone today, so the row says where it is done instead of offering a
 * Connect that opened a browser tab which could only end in "Not authenticated"
 * or "Invalid state parameter": the server keeps the sign-in's state in the
 * session that asked for it — the app's — and the provider sends the browser
 * back to the server with a session of its own. Disconnecting works here.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import type { ConnectorState } from '../model/connectorState';

export function ConnectorActions({
    state,
    busy,
    label,
    connectsHere,
    onConnect,
    onDisconnect,
}: {
    state: ConnectorState;
    busy: boolean;
    /** The provider's name, for the sentence that says where to connect it. */
    label: string;
    /** False for a provider that is connected elsewhere (see above). */
    connectsHere: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!connectsHere && !(state.connected && !state.needsReauth) && !state.notConfigured) {
        return (
            <Text variant="caption" tone="tertiary" testID="connect-elsewhere">
                {state.needsReauth
                    ? t('mobile.integrations.reconnect_elsewhere', 'Reconnect {name} from Bee Flow on a computer, under Settings → Integrations. It works here again as soon as it is reconnected.', { name: label })
                    : t('mobile.integrations.connect_elsewhere', 'Connect {name} from Bee Flow on a computer, under Settings → Integrations. Once it is connected, your agents use it here too.', { name: label })}
            </Text>
        );
    }
    if (state.notConfigured) {
        return (
            <Text variant="caption" tone="tertiary">
                An administrator has to add this provider&rsquo;s client credentials before
                anyone in your organisation can connect it.
            </Text>
        );
    }
    return (
        <View style={styles.actions}>
            {state.connected && !state.needsReauth ? (
                <Button
                    label="Disconnect"
                    variant="secondary"
                    onPress={onDisconnect}
                    loading={busy}
                    style={styles.action}
                />
            ) : (
                <Button
                    label={state.needsReauth ? 'Reconnect' : 'Connect'}
                    variant={state.needsReauth ? 'primary' : 'secondary'}
                    onPress={onConnect}
                    style={styles.action}
                />
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
        action: { flex: 1 },
    });
