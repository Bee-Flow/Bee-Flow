/**
 * The accounts you can link — Google, Microsoft, LinkedIn, Withings, GitHub.
 * GitHub (a token) connects here; the OAuth providers are connected from a
 * computer and used here (ConnectorActions says why), and the footer says so
 * once for the whole group.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group } from '@/shared/ui';

import { ConnectorRow } from './ConnectorRow';
import { CONNECTORS, type Connector } from '../model/catalog';
import type { IntegrationStatus } from '../model/types';

export function ConnectedAccountsGroup({
    statuses,
    disconnecting,
    onConnect,
    onDisconnect,
}: {
    /** One result per connector, in CONNECTORS order. */
    statuses: { data: IntegrationStatus | null | undefined; isLoading: boolean }[];
    /** The provider whose disconnect is in flight, if any. */
    disconnecting: string | null;
    onConnect: (connector: Connector) => void;
    onDisconnect: (connector: Connector) => void;
}) {
    const t = useTranslation();
    return (
        <Group
            title="Connected accounts"
            footer={t(
                'mobile.integrations.accounts_footer',
                'Accounts that sign in with Google, Microsoft, LinkedIn or Withings are connected from Bee Flow on a computer. Once connected, they work in the app too.',
            )}
        >
            {CONNECTORS.map((connector, index) => {
                const query = statuses[index];
                return (
                    <ConnectorRow
                        key={connector.provider}
                        connector={connector}
                        status={query?.data ?? null}
                        loading={Boolean(query?.isLoading)}
                        busy={disconnecting === connector.provider}
                        onConnect={() => onConnect(connector)}
                        onDisconnect={() => onDisconnect(connector)}
                    />
                );
            })}
        </Group>
    );
}
