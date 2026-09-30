/**
 * History: the page's versions, newest first, fifty at a time — the web's
 * Version history. A tap offers Restore (the server first saves what is
 * there now, so a restore can itself be undone) and Delete; "Save snapshot"
 * keeps the current state by hand.
 *
 * On a React + Material UI page a snapshot holds only the three slots and
 * the page database, not the app in `src/*`; the tab says so rather than
 * letting an empty list read as "you have not edited enough yet".
 */

import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { ActionMenu, Banner, Button, InsetDivider, Spinner, useToast, type ActionMenuItem } from '@/shared/ui';

import { ListFallback } from './ListFallback';
import { VersionRow } from './VersionRow';
import { useCreateVersion, useDeleteVersion, useRestoreVersion } from '../hooks/buildMutations';
import { useWebpageVersions } from '../hooks/queries';
import type { WebpageVersion } from '../model/buildTypes';
import { flattenVersions, versionTitle } from '../model/versions';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fill: { flex: 1 },
        header: { padding: theme.spacing.lg, gap: theme.spacing.md },
        list: { paddingBottom: theme.spacing.xxxl },
    });

const keyOf = (v: WebpageVersion) => v.id;
const Separator = () => <InsetDivider />;

function useVersionMenu(pageId: string, version: WebpageVersion | null): ActionMenuItem[] {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const onError = (err: Error) => toast(describeError(err).message, 'error');
    const restore = useRestoreVersion(pageId, {
        onSuccess: () => toast(t('mobile.webpages.versions.restored', 'Version restored'), 'success'),
        onError,
    });
    const remove = useDeleteVersion(pageId, { onError });
    if (!version) return [];
    const ask = async (restoring: boolean) => {
        const ok = await confirm({
            title: restoring
                ? t('mobile.webpages.versions.confirm_restore', 'Restore {name}?', { name: versionTitle(version) })
                : t('mobile.webpages.versions.confirm_delete', 'Delete this version?'),
            message: restoring
                ? t(
                      'mobile.webpages.versions.confirm_restore_body',
                      'The current files are saved as a new version first, so you can go back.',
                  )
                : t(
                      'mobile.webpages.versions.confirm_delete_body',
                      'This snapshot is removed from the history for good.',
                  ),
            confirmLabel: restoring
                ? t('routine_editor.version_restore', 'Restore')
                : t('common.delete', 'Delete'),
            tone: restoring ? 'primary' : 'destructive',
        });
        if (ok && restoring) restore.mutate(version.id);
        else if (ok) remove.mutate(version.id);
    };
    return [
        {
            id: 'restore',
            label: t('routine_editor.version_restore', 'Restore'),
            icon: 'RotateCcw',
            onPress: () => void ask(true),
        },
        {
            id: 'delete',
            label: t('common.delete', 'Delete'),
            icon: 'Trash2',
            destructive: true,
            onPress: () => void ask(false),
        },
    ];
}

export function HistoryTab({ pageId }: { pageId: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const versions = useWebpageVersions(pageId);
    const refresh = useUserRefresh(() => versions.refetch());
    const [selected, setSelected] = useState<WebpageVersion | null>(null);
    const menu = useVersionMenu(pageId, selected);
    const snapshot = useCreateVersion(pageId, {
        onSuccess: () => toast(t('mobile.webpages.versions.saved', 'Snapshot saved'), 'success'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const rows = flattenVersions(versions.data?.pages);
    const coversProject = versions.data?.pages[0]?.coversProject ?? true;
    const renderItem = useCallback(
        ({ item }: { item: WebpageVersion }) => <VersionRow version={item} onPress={setSelected} />,
        [],
    );

    const empty = (
        <ListFallback
            query={versions}
            icon="History"
            title={t(
                'mobile.webpages.versions.empty',
                'No versions yet. Auto-snapshots are created every 5 minutes when you edit.',
            )}
        />
    );

    return (
        <View style={styles.fill}>
            <FlatList
                data={rows}
                keyExtractor={keyOf}
                renderItem={renderItem}
                ItemSeparatorComponent={Separator}
                ListHeaderComponent={
                    <View style={styles.header}>
                        {coversProject ? null : (
                            <Banner tone="info">
                                {t(
                                    'mobile.webpages.versions.not_covered',
                                    'Versions keep index.html, style.css, script.js and the page database. This page’s app lives in its project files, which versions do not cover.',
                                )}
                            </Banner>
                        )}
                        <Button
                            label={t('mobile.webpages.versions.snapshot', 'Save snapshot')}
                            variant="secondary"
                            iconName="History"
                            loading={snapshot.isPending}
                            onPress={() => snapshot.mutate(undefined)}
                        />
                    </View>
                }
                ListEmptyComponent={empty}
                ListFooterComponent={versions.isFetchingNextPage ? <Spinner /> : null}
                onEndReached={() => {
                    if (versions.hasNextPage && !versions.isFetchingNextPage) void versions.fetchNextPage();
                }}
                onEndReachedThreshold={0.5}
                contentContainerStyle={styles.list}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
            />
            <ActionMenu
                visible={selected !== null}
                onClose={() => setSelected(null)}
                title={selected ? versionTitle(selected) : undefined}
                items={menu}
            />
        </View>
    );
}
