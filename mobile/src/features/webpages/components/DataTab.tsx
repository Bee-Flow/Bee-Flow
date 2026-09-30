/**
 * Data & links: what the page is wired to — the web's Data tab and its Apps
 * & data panel on one page. The tables it reads (and the automations that
 * write to them behind its back), the integrations and automations its
 * bridge may run for it — which can be removed here, and automations added —
 * and the calls it makes to other sites from its own code, which appear
 * nowhere else and have no approval step.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { BlockList, useConfirm, useUserRefresh, type Block } from '@/shared/patterns';
import { Button, LoadingState, useToast } from '@/shared/ui';

import { AutomationPickerSheet } from './AutomationPickerSheet';
import { callBlocks, grantBlocks, heading, sectionOf, tableBlocks } from './dataBlocks';
import type { GrantLine } from './DataRows';
import { useRevokeGrant } from '../hooks/audienceMutations';
import { useWebpageCalls, useWebpageDataCards, useWebpageGrants } from '../hooks/queries';

function useRevoke(pageId: string) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const revoke = useRevokeGrant(pageId, { onError: (err) => toast(describeError(err).message, 'error') });
    return async (grant: GrantLine) => {
        const ok = await confirm({
            title: t('mobile.webpages.data.revoke_title', 'Remove {name}?', { name: grant.title }),
            message: t(
                'mobile.webpages.data.revoke_body',
                'The page can no longer run it. Buttons that use it stop working.',
            ),
            confirmLabel: t('common.remove', 'Remove'),
        });
        if (ok) revoke.mutate({ kind: grant.kind, key: grant.key });
    };
}

export function DataTab({ pageId }: { pageId: string }) {
    const t = useTranslation();
    const cards = useWebpageDataCards(pageId);
    const grants = useWebpageGrants(pageId);
    const calls = useWebpageCalls(pageId);
    const refresh = useUserRefresh(() => Promise.all([cards.refetch(), grants.refetch(), calls.refetch()]));
    const [picking, setPicking] = useState(false);
    const revoke = useRevoke(pageId);

    if (cards.isLoading && grants.isLoading && calls.isLoading) return <LoadingState />;

    const blocks: Block[] = [
        heading(
            'tables',
            t('webpages.sources.tables', 'Tables'),
            t('mobile.webpages.data.tables_hint', 'The data tables this page reads'),
        ),
        ...sectionOf('tables', cards, tableBlocks),
        heading(
            'grants',
            t('mobile.webpages.data.grants', 'What this page may run'),
            t('mobile.webpages.data.grants_hint', 'Run as you, from the page’s own buttons and forms'),
            <Button
                label={t('common.add', 'Add')}
                variant="ghost"
                size="sm"
                iconName="Plus"
                onPress={() => setPicking(true)}
            />,
        ),
        ...sectionOf('grants', grants, (data) => grantBlocks(data, (g) => void revoke(g))),
        heading(
            'calls',
            t('mobile.webpages.data.calls', 'Calls in its own code'),
            t('mobile.webpages.data.calls_hint', 'Not in Runs, and no approval step'),
        ),
        ...sectionOf('calls', calls, callBlocks),
    ];

    return (
        <>
            <BlockList
                blocks={blocks}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
            <AutomationPickerSheet
                pageId={pageId}
                visible={picking}
                granted={grants.data?.automations.map((g) => g.automationId) ?? []}
                onClose={() => setPicking(false)}
            />
        </>
    );
}
