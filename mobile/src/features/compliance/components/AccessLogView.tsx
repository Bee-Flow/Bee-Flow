/**
 * The sign-in and access trail (web: pages/AccessAuditPage, ISO A.8.15).
 * Filtering and paging go to the SERVER — "every refused sign-in" must not
 * silently mean "…on this page" — and the export is exactly what the filter
 * selects, handed to the share sheet as JSON.
 *
 * Server: routes/compliance/accessAudit.js (AuditQuery `.strict()`: action,
 * limit, offset; the export is rate-limited per user).
 */

import React, { useState } from 'react';
import { StyleSheet, View, type ListRenderItem } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Button, FilterPills, ListRow, Text, useToast } from '@/shared/ui';

import { accessAuditExportPath, shareDownload } from '../api/endpoints';
import type { AccessAuditPage } from '../api/readersPages';
import { useAccessAudit, useAccessAuditActions } from '../hooks/queries';
import { formatDate } from '../hooks/useFormatter';

type Entry = AccessAuditPage['entries'][number];

/** The web's labels for the actions it names; anything else shows as written. */
const ACTION_LABELS: Record<string, { i18nKey: string; en: string }> = {
    login_succeeded: { i18nKey: 'compliance.aa_action_login_ok', en: 'Signed in' },
    login_failed: { i18nKey: 'compliance.aa_action_login_fail', en: 'Sign-in refused' },
    login_blocked: { i18nKey: 'compliance.aa_action_login_blocked', en: 'Sign-in blocked' },
};

function EntryRow({ entry }: { entry: Entry }) {
    const t = useTranslation();
    const label = ACTION_LABELS[entry.action];
    return (
        <ListRow
            title={label ? t(label.i18nKey, label.en) : entry.action}
            subtitle={[formatDate(entry.created_at), entry.target_type, entry.changed_by].filter(Boolean).join(' · ') || undefined}
        />
    );
}

const renderItem: ListRenderItem<Entry> = ({ item }) => <EntryRow entry={item} />;
const keyOf = (e: Entry) => e.id;

export function AccessLogView() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [action, setAction] = useState('');
    const [offset, setOffset] = useState(0);
    const page = useAccessAudit(action || null, offset, true);
    const actions = useAccessAuditActions(true);
    const total = page.data?.total ?? 0;
    const limit = page.data?.limit ?? 50;

    const pick = (next: string) => {
        setAction(next);
        setOffset(0);
    };
    const exportLog = () =>
        shareDownload({ path: accessAuditExportPath({ action: action || undefined }), fileName: 'access-audit.json', mimeType: 'application/json' }).catch(
            (err: unknown) => toast(describeError(err).message, 'error'),
        );

    const header = (
        <View style={styles.header}>
            <Text variant="caption" tone="secondary">
                {t('compliance.aa_count', '{total} events', { total })}
            </Text>
            <FilterPills
                scroll
                testID="aa-filter"
                value={action}
                onChange={pick}
                options={[{ value: '', label: t('compliance.aa_filter_any', 'Any') }, ...(actions.data ?? []).map((a) => ({ value: a, label: ACTION_LABELS[a] ? t(ACTION_LABELS[a].i18nKey, ACTION_LABELS[a].en) : a }))]}
            />
            <Button testID="aa-export" size="sm" variant="secondary" iconName="FileDown" label={t('compliance.aa_export', 'Export (JSON)')} onPress={() => void exportLog()} />
        </View>
    );
    const footer = (
        <View style={styles.pager}>
            <Button size="sm" variant="ghost" label={t('common.previous', 'Previous')} disabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - limit))} />
            <Button size="sm" variant="ghost" label={t('common.next', 'Next')} disabled={offset + limit >= total} onPress={() => setOffset(offset + limit)} />
        </View>
    );
    return (
        <QueryList
            query={{ ...page, data: page.data?.entries }}
            renderItem={renderItem}
            keyExtractor={keyOf}
            empty={{ icon: 'History', title: t('compliance.aa_empty_title', 'No events in this range') }}
            ListHeaderComponent={header}
            ListFooterComponent={total > limit ? footer : null}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing[3], paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing[3], alignItems: 'flex-start' },
        pager: { flexDirection: 'row', justifyContent: 'space-between', padding: theme.spacing.lg },
    });
