/**
 * Knowledge: what the builder may read and cite — files, web pages and
 * pasted text (the web's Knowledge pane, WebpageSources.jsx). The list polls
 * while a source is being read (hooks/queries useWebpageSources) and each row
 * offers what can still be done with it: retry a failed read, cancel a stuck
 * one, remove it.
 *
 * Files upload through the Library's queue, so a large PDF shows its
 * progress and can be cancelled like any other upload in the app.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { pickDocuments, UploadQueue, useUploadQueue } from '@/features/knowledge';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { ActionMenu, Button, InsetDivider, useToast, type ActionMenuItem } from '@/shared/ui';

import { AddSourceSheet, type AddSourceKind } from './AddSourceSheet';
import { ListFallback } from './ListFallback';
import { SourceRow } from './SourceRow';
import { sourceUploadTarget } from '../api/buildEndpoints';
import { useSourceAction, type SourceAction } from '../hooks/buildMutations';
import { useWebpageSources } from '../hooks/queries';
import type { WebpageSource } from '../model/buildTypes';
import { canCancelSource, canRetrySource } from '../model/sources';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fill: { flex: 1 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm, padding: theme.spacing.lg },
        grow: { flex: 1 },
        list: { paddingBottom: theme.spacing.xxxl },
    });

const keyOf = (source: WebpageSource) => source.id;
const Separator = () => <InsetDivider />;

function useSourceMenu(pageId: string, source: WebpageSource | null): ActionMenuItem[] {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const act = useSourceAction(pageId, { onError: (err) => toast(describeError(err).message, 'error') });
    if (!source) return [];
    const run = (action: SourceAction) => act.mutate({ action, sourceId: source.id });
    const remove = async () => {
        const ok = await confirm({
            title: t('mobile.webpages.source.confirm_delete', 'Remove this knowledge item?'),
            message: t('mobile.webpages.source.confirm_delete_body', 'The builder will no longer read or cite it.'),
            confirmLabel: t('common.remove', 'Remove'),
        });
        if (ok) run('delete');
    };
    const items: ActionMenuItem[] = [];
    if (canRetrySource(source)) {
        items.push({
            id: 'retry',
            label: t('mobile.webpages.source.retry', 'Retry'),
            icon: 'RotateCw',
            onPress: () => run('retry'),
        });
    }
    if (canCancelSource(source)) {
        items.push({
            id: 'cancel',
            label: t('common.cancel', 'Cancel'),
            icon: 'CircleX',
            onPress: () => run('cancel'),
        });
    }
    items.push({
        id: 'delete',
        label: t('common.remove', 'Remove'),
        icon: 'Trash2',
        destructive: true,
        onPress: () => void remove(),
    });
    return items;
}

export function KnowledgeTab({ pageId }: { pageId: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const sources = useWebpageSources(pageId);
    const refresh = useUserRefresh(() => sources.refetch());
    const [adding, setAdding] = useState<AddSourceKind | null>(null);
    const [selected, setSelected] = useState<WebpageSource | null>(null);
    const uploads = useUploadQueue(sourceUploadTarget(pageId), { onUploaded: () => void sources.refetch() });
    const menu = useSourceMenu(pageId, selected);
    const renderItem = useCallback(
        ({ item }: { item: WebpageSource }) => <SourceRow source={item} onPress={setSelected} />,
        [],
    );

    const pickFiles = async () => {
        const files = await pickDocuments();
        if (files.length) uploads.add(files);
    };

    const header = (
        <View>
            <View style={styles.actions}>
                <Button
                    label={t('mobile.webpages.source.add_file', 'File')}
                    variant="secondary"
                    iconName="Upload"
                    onPress={() => void pickFiles()}
                    style={styles.grow}
                />
                <Button
                    label={t('mobile.webpages.source.add_url', 'URL')}
                    variant="secondary"
                    iconName="Globe"
                    onPress={() => setAdding('url')}
                    style={styles.grow}
                />
                <Button
                    label={t('mobile.webpages.source.add_text', 'Text')}
                    variant="secondary"
                    iconName="Type"
                    onPress={() => setAdding('text')}
                    style={styles.grow}
                />
            </View>
            {uploads.items.length ? (
                <UploadQueue
                    items={uploads.items}
                    onRetry={uploads.retry}
                    onRemove={uploads.remove}
                    onClearFinished={uploads.clearFinished}
                />
            ) : null}
        </View>
    );

    const empty = (
        <ListFallback
            query={sources}
            icon="BookOpen"
            title={t('mobile.webpages.source.empty_title', 'No knowledge yet')}
            message={t(
                'mobile.webpages.source.empty_body',
                'Add a file, URL, or paste text — the AI can use it as reference and inspiration.',
            )}
        />
    );

    return (
        <View style={styles.fill}>
            <FlatList
                data={sources.data ?? []}
                keyExtractor={keyOf}
                renderItem={renderItem}
                ItemSeparatorComponent={Separator}
                ListHeaderComponent={header}
                ListEmptyComponent={empty}
                contentContainerStyle={styles.list}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
            <ActionMenu
                visible={selected !== null}
                onClose={() => setSelected(null)}
                title={selected?.name}
                items={menu}
            />
            <AddSourceSheet pageId={pageId} kind={adding} onClose={() => setAdding(null)} />
        </View>
    );
}
