/**
 * Let the page run one of your automations — the web's "Add routine" in its
 * Apps & data panel. The page's bridge runs it as you, so only your own
 * automations are offered, and one already granted is left out.
 */

import React, { useCallback } from 'react';
import { FlatList } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useAutomations, type Automation } from '@/features/automations';
import { ListRow, Sheet, useToast } from '@/shared/ui';

import { ListFallback } from './ListFallback';
import { useGrantAutomation } from '../hooks/audienceMutations';

const keyOf = (a: Automation) => a.id;

export function AutomationPickerSheet({
    pageId,
    visible,
    granted,
    onClose,
}: {
    pageId: string;
    visible: boolean;
    granted: readonly string[];
    onClose: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const automations = useAutomations();
    const grant = useGrantAutomation(pageId, {
        onSuccess: () => {
            toast(t('mobile.webpages.data.granted', 'The page can run it now'), 'success');
            onClose();
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const rows = (automations.data ?? []).filter((a) => a.kind === 'automation' && !granted.includes(a.id));
    const renderItem = useCallback(
        ({ item }: { item: Automation }) => (
            <ListRow
                title={item.title}
                subtitle={item.description ?? undefined}
                disabled={grant.isPending}
                onPress={() => grant.mutate({ automationId: item.id, label: item.title })}
            />
        ),
        [grant],
    );

    const empty = (
        <ListFallback
            query={automations}
            icon="Workflow"
            title={t('mobile.webpages.data.no_automations', 'No automations to add')}
        />
    );

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.webpages.data.add_automation', 'Add an automation')}
            subtitle={t(
                'mobile.webpages.data.add_automation_hint',
                'The page runs it as you, from its own buttons and forms',
            )}
            scroll={false}
            tall
        >
            <FlatList data={rows} keyExtractor={keyOf} renderItem={renderItem} ListEmptyComponent={empty} />
        </Sheet>
    );
}
