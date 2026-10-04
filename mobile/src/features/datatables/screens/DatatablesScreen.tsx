/**
 * Studio → Datatables: the tables automations read and write between runs
 * (the web's DatatablesStudio).
 *
 * The list is already filtered by the SERVER's grade resolver, the one the
 * runner uses, so a table nobody shared with you is not hidden here — it is
 * not there at all. The list answers across BOTH scopes: a personal table made
 * before joining an organisation stays visible to its owner.
 *
 * Where a NEW table would go is said above the list before anything is
 * offered, because "your organisation" and "this account" are not the same
 * promise. `manage_datatables` is asked only for an organisation table; an
 * account with no organisation can always make a personal one.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { QueryList } from '@/shared/patterns';
import { Banner, Button, Screen, ScreenHeader } from '@/shared/ui';

import { DatatableRow } from '../components/DatatableRow';
import { NewDatatableSheet } from '../components/NewDatatableSheet';
import { useDatatables } from '../hooks/queries';
import type { Datatable } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ notice: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

const matches = (table: Datatable, needle: string) =>
    `${table.name} ${table.key} ${table.description}`.toLowerCase().includes(needle);

const keyOf = (table: Datatable) => table.id;

/** `startCreating` opens the New table sheet at once: the Studio New menu's `/datatables?new=1`. */
export function DatatablesScreen({ startCreating }: { startCreating?: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const query = useDatatables();
    const canManage = useHasPermission('manage_datatables');
    const [creating, setCreating] = useState(startCreating === true);
    const scope = query.data?.scope ?? null;
    const canCreate = scope?.kind === 'user' || canManage;
    const tables = query.data?.tables;
    const open = useCallback((id: string) => router.push(`/datatables/${id}`), [router]);
    const renderItem = useCallback(({ item }: { item: Datatable }) => <DatatableRow table={item} onOpen={open} />, [open]);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('datatables.title', 'Datatables')}
                subtitle={
                    // The web's own "{count} table(s)" pair (a Solution's
                    // install summary counts tables the same way), so one
                    // table is not "1 tables" and Dutch gets its own plural.
                    tables ? nOf(t, 'solutions.install_count_datatables', tables.length, ['{count} table', '{count} tables']) : undefined
                }
                actions={
                    canCreate ? (
                        <Button size="sm" iconName="Plus" label={t('datatables.new', 'New table')} onPress={() => setCreating(true)} testID="new-datatable" />
                    ) : null
                }
            />
            {canCreate && scope ? (
                <View style={styles.notice}>
                    <Banner tone="info" icon={scope.kind === 'user' ? 'User' : 'Building2'}>
                        {scope.kind === 'user'
                            ? t('datatables.scope_notice_personal', 'New tables here are personal — only this account can see them, and they cannot be shared.')
                            : t('datatables.scope_notice_org', 'New tables here belong to your organisation. You choose afterwards who may read or change them.')}
                    </Banner>
                </View>
            ) : null}
            <QueryList
                query={{ ...query, data: tables }}
                keyExtractor={keyOf}
                search={{ placeholder: t('datatables.search_short', 'Search a table…'), match: matches }}
                renderItem={renderItem}
                empty={{
                    icon: 'Table',
                    title: t('datatables.empty_title', 'No datatables yet'),
                    message: canCreate
                        ? t('datatables.empty_can_create', 'Make one when an automation needs to remember something between runs — a list of customers it has already e-mailed, a running total, rows a second automation picks up.')
                        : t('datatables.empty_cannot_create', 'Tables in this organisation are created by an administrator. Once one is shared with you it appears here, and your automations can use it.'),
                    ...(canCreate ? { actionLabel: t('datatables.new', 'New table'), onAction: () => setCreating(true) } : {}),
                }}
                noMatch={{
                    title: t('datatables.search_empty', 'No table matches that.'),
                    clearLabel: t('automations.mapping.clear_search', 'Clear search'),
                }}
            />
            {/* Mounted per opening, so the form seeds from the scope as it is now. */}
            {creating ? (
                <NewDatatableSheet
                    visible
                    scope={scope}
                    canManage={canManage}
                    onClose={() => setCreating(false)}
                    onCreated={(table) => {
                        setCreating(false);
                        open(table.id);
                    }}
                />
            ) : null}
        </Screen>
    );
}
