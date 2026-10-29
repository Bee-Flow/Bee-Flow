/** What the token card shows once its status is known: the state, the endpoint, the buttons. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { LinkActions } from '@/features/webpages';
import { Badge, Button, Text } from '@/shared/ui';

import type { TokenFlow } from '../hooks/useTokenFlow';
import type { McpTokenStatus } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        state: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        grow: { flex: 1 },
        endpoint: { gap: theme.spacing.sm },
        buttons: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

export function TokenDetails({
    status,
    endpoint,
    flow,
}: {
    status: McpTokenStatus | undefined;
    endpoint: string | null;
    flow: TokenFlow;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const exists = Boolean(status?.exists);

    return (
        <>
            <View style={styles.state}>
                <Badge label={exists ? t('skills.state_active', 'Active') : t('common.none', 'None')} tone={exists ? 'success' : 'neutral'} />
                <Text variant="caption" tone="tertiary" style={styles.grow}>
                    {exists
                        ? t('mobile.mcp.token_held', 'A client is holding a working token.')
                        : t('mobile.mcp.token_none', 'No token yet — a client cannot reach Bee Flow.')}
                </Text>
            </View>

            <Text variant="caption" tone="tertiary">
                {t('mobile.mcp.token_scope', "A token grants exactly what you can do in chat — no more. Your organisation's integration and group rules still apply on every call.")}
            </Text>

            {endpoint ? (
                <View style={styles.endpoint}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.mcp.endpoint', 'Endpoint · {transport}', { transport: status?.transport ?? '' })}
                    </Text>
                    {/* It answers MCP over HTTP, not HTML — opening it in a
                        browser shows a protocol error, not a page. */}
                    <LinkActions url={endpoint} shareTitle={t('mobile.mcp.endpoint_share', 'Bee Flow MCP endpoint')} allowOpen={false} />
                </View>
            ) : null}

            <View style={styles.buttons}>
                <Button
                    label={exists ? t('mobile.mcp.replace_token', 'Replace token') : t('mobile.mcp.create_token', 'Create token')}
                    loading={flow.mint.isPending}
                    onPress={() => (exists ? flow.setConfirmMint(true) : flow.mint.mutate())}
                    style={styles.half}
                />
                {exists ? (
                    <Button
                        label={t('connections.revoke', 'Revoke')}
                        variant="danger"
                        onPress={() => flow.setConfirmRevoke(true)}
                        style={styles.half}
                    />
                ) : null}
            </View>
        </>
    );
}
