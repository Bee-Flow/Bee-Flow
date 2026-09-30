/**
 * INBOUND: Bee Flow served AS an MCP server, at /mcp, so Nextcloud's
 * Assistant (or any other client) can call your integrations and routines.
 * That needs a bearer token, because a static config file cannot hold a
 * session cookie. One per user, minted here.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { absoluteUrl } from '@/features/webpages';
import { Card, Section, Text } from '@/shared/ui';

import { ProblemBanner } from './ProblemBanner';
import { TokenDetails } from './TokenDetails';
import type { useMcpToken } from '../hooks/queries';
import type { TokenFlow } from '../hooks/useTokenFlow';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.md } });

/**
 * The token endpoint answers a bare `/mcp` when PUBLIC_BASE_URL is unset — the
 * common self-host case. absoluteUrl fixes that against this device's server,
 * but throws when none is configured, and a nicety must not crash the screen.
 */
function safeAbsolute(url: string): string | null {
    try {
        return absoluteUrl(url);
    } catch {
        return null;
    }
}

export function TokenSection({ token, flow }: { token: ReturnType<typeof useMcpToken>; flow: TokenFlow }) {
    const styles = useThemedStyles(makeStyles);
    const endpoint = token.data ? safeAbsolute(token.data.url) : null;

    let body: React.ReactNode;
    if (token.isLoading) {
        body = (
            <Text variant="body" tone="tertiary">
                Checking…
            </Text>
        );
    } else if (token.isError) {
        body = <ProblemBanner error={token.error} onRetry={() => void token.refetch()} />;
    } else {
        body = <TokenDetails status={token.data} endpoint={endpoint} flow={flow} />;
    }

    return (
        <Section title="Your access token" subtitle="Lets an MCP client call Bee Flow as you">
            <Card>
                <View style={styles.body}>{body}</View>
            </Card>
        </Section>
    );
}
