/**
 * OUTBOUND: the servers Bee Flow calls. Installing one means a command line or
 * a URL plus credentials, which is desktop work; what a phone is for is
 * noticing that one of them has been failing since Tuesday. An administrator
 * configures a handful, so they are drawn in one card. Re-probing a server
 * (POST /ai/mcp-servers/:id/refresh) is the platform operator's, so it stays
 * on the web's admin dashboard.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Divider, ListSkeleton, Section, Text } from '@/shared/ui';

import { ProblemBanner } from './ProblemBanner';
import { ServerRow } from './ServerRow';
import type { useMcpServers } from '../hooks/queries';
import type { McpServer } from '../model/types';

function ServerList({ rows }: { rows: McpServer[] }) {
    const theme = useTheme();

    return (
        <Card padded={false}>
            {rows.map((server, index) => (
                <View key={server.id}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <ServerRow server={server} />
                </View>
            ))}
        </Card>
    );
}

export function ServersSection({ servers }: { servers: ReturnType<typeof useMcpServers> }) {
    const rows = servers.data ?? [];
    let body: React.ReactNode;
    if (servers.isLoading) {
        body = <ListSkeleton rows={3} />;
    } else if (servers.isError) {
        // The marketplace is an Enterprise feature, so a 403 here is an answer
        // about the licence — and it must not take the ungated token section
        // down with it.
        body = <ProblemBanner error={servers.error} onRetry={() => void servers.refetch()} />;
    } else if (rows.length === 0) {
        body = (
            <Card>
                <Text variant="body" tone="tertiary">
                    No MCP servers are configured. An administrator adds them in the
                    web app — each one needs a command or a URL, and usually a
                    credential.
                </Text>
            </Card>
        );
    } else {
        body = <ServerList rows={rows} />;
    }

    return (
        <Section title="Connected servers" subtitle="What Bee Flow can call out to">
            {body}
        </Section>
    );
}
