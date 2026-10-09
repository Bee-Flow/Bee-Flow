/**
 * Integrations.
 *
 * Two halves, because the server has two:
 *
 *   CONNECTED ACCOUNTS — Google, Microsoft, LinkedIn, Withings, GitHub. Each
 *   has its own router with /status, /auth-url and /disconnect, and none of
 *   them share a response shape.
 *
 *   WHAT THE MODEL MAY USE — the per-user `enabledApps` allow-list on
 *   `/ai/user-settings`, intersected server-side with what the organisation
 *   permits. Turning one on does not connect anything; it decides whether the
 *   tool is offered to the model at all.
 */

import React, { useMemo, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import {
    Banner,
    GroupedScroll,
    ListSkeleton,
    Screen,
    ScreenHeader,
    useToast,
} from '@/shared/ui';

import { CatalogueGroups } from '../components/CatalogueGroups';
import { ConnectedAccountsGroup } from '../components/ConnectedAccountsGroup';
import { CredentialsGroup } from '../components/CredentialsGroup';
import { GithubSheet } from '../components/GithubSheet';
import { useDisconnectIntegration, useSaveEnabledApps } from '../hooks/mutations';
import { useConnectorStatuses, useUserSettings } from '../hooks/queries';
import { allowedByOrg, INTEGRATION_CATALOG, orderCategories, type Connector } from '../model/catalog';

export function IntegrationsScreen() {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const [githubSheet, setGithubSheet] = useState(false);

    const statuses = useConnectorStatuses();
    const settings = useUserSettings();
    const saveApps = useSaveEnabledApps();
    const disconnect = useDisconnectIntegration({ onDone: () => toast('Disconnected', 'success') });

    // The org's allow-list narrows what is worth showing at all: a tool the
    // organisation forbids cannot be enabled, and a toggle that always fails
    // is worse than an absent one.
    const orgAllowed = settings.data?.orgEnabledIntegrations;
    const catalogue = useMemo(() => allowedByOrg(INTEGRATION_CATALOG, orgAllowed), [orgAllowed]);
    const categories = useMemo(
        () => orderCategories([...new Set(catalogue.map((entry) => entry.category))]),
        [catalogue],
    );

    /**
     * `enabledApps: null` means "no explicit list" — which the runtime reads as
     * everything allowed. Materialising it into the full catalogue on the first
     * toggle keeps the switch honest: before the first change every switch
     * shows on, because everything IS on.
     */
    const enabled = settings.data?.enabledApps ?? catalogue.map((entry) => entry.id);
    const enabledSet = new Set(enabled);
    const toggleApp = (id: string) =>
        saveApps.mutate(enabledSet.has(id) ? enabled.filter((x) => x !== id) : [...enabled, id]);

    const confirmDisconnect = async (connector: Connector) => {
        const ok = await confirm({
            title: `Disconnect ${connector.label}?`,
            message: t(
                'mobile.integrations.disconnect_message',
                'Your agents and automations lose access to it immediately. Anything already saved in Bee Flow stays.',
            ),
            confirmLabel: t('automations.node_context_menu.disconnect', 'Disconnect'),
        });
        if (ok) disconnect.mutate(connector.provider);
    };

    const refresh = useUserRefresh(() => Promise.all([...statuses.map((query) => query.refetch()), settings.refetch()]));

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Integrations" subtitle="Accounts, and what your agents may use" />

            <GroupedScroll refresh={refresh}>
                {disconnect.isError ? (
                    <Banner tone="error">{describeError(disconnect.error).message}</Banner>
                ) : null}

                <ConnectedAccountsGroup
                    statuses={statuses}
                    disconnecting={disconnect.isPending ? (disconnect.variables ?? null) : null}
                    onConnect={(connector) => {
                        if (connector.flow === 'token') setGithubSheet(true);
                    }}
                    onDisconnect={(connector) => void confirmDisconnect(connector)}
                />

                {orgAllowed ? (
                    <Banner tone="info" icon="Info">
                        Your organisation limits which tools may be used. Anything it has not
                        allowed is not listed below.
                    </Banner>
                ) : null}

                {settings.isLoading ? (
                    <ListSkeleton rows={6} />
                ) : (
                    <CatalogueGroups
                        catalogue={catalogue}
                        categories={categories}
                        enabled={enabledSet}
                        onToggle={toggleApp}
                    />
                )}

                <CredentialsGroup settings={settings.data} />
            </GroupedScroll>

            <GithubSheet
                visible={githubSheet}
                onClose={() => setGithubSheet(false)}
                onConnected={() => {
                    setGithubSheet(false);
                    toast('GitHub connected', 'success');
                }}
            />
        </Screen>
    );
}
