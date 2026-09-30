/**
 * The Sharing tab — who can READ the rows and, separately, who can CHANGE them
 * (the web's DatatableSharing). The separation is the design: on the server an
 * empty group list on a published table means the whole organisation, so if
 * one setting governed both, "share this with the company" would mean "let
 * the company delete rows". The decisions and their confirmations live in
 * useSharingActions.
 *
 * A PERSONAL table has no audience at all; the server refuses every sharing
 * request for one, so the tab states the rule instead of offering a choice.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Card, OptionRow, Section, Text, ToggleRow } from '@/shared/ui';

import { GrantSheet } from './GrantSheet';
import { GrantsSection } from './GrantsSection';
import { GroupPickerSheet } from './GroupPickerSheet';
import { useOrgDirectory } from '../hooks/queries';
import { useSharingActions } from '../hooks/useSharingActions';
import type { Datatable } from '../model/types';
import { describeAccess, joinNames } from '../model/words';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ content: { padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: theme.spacing.xxxl } });

function PersonalNotice() {
    const t = useTranslation();
    return (
        <Banner tone="info" icon="User">
            <Text variant="body" weight="semibold">{t('datatables.share_personal_title', 'This table cannot be shared')}</Text>
            <Text variant="caption">
                {t('datatables.share_personal_body', 'It belongs to this account alone. Nobody else can read or change its rows — not colleagues, not administrators — and there is no setting that would change that. To share data with the rest of your organisation, make an organisation table.')}
            </Text>
        </Banner>
    );
}

export function SharingTab({ table, canEdit }: { table: Datatable; canEdit: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const personal = table.scopeKind === 'user';
    return (
        <ScrollView contentContainerStyle={styles.content}>
            {personal ? <PersonalNotice /> : <OrgSharing table={table} canEdit={canEdit} />}
        </ScrollView>
    );
}

function OrgSharing({ table, canEdit }: { table: Datatable; canEdit: boolean }) {
    const t = useTranslation();
    const directory = useOrgDirectory(true).data;
    const groupName = (id: string) => directory?.groups.find((g) => g.id === id)?.name || id;
    const actions = useSharingActions(table, (ids) => joinNames(t, ids.map(groupName)));
    const access = describeAccess(t, table, groupName);
    const [sheet, setSheet] = useState<'groups' | 'grant' | null>(null);
    const off = !canEdit || actions.busy;

    return (
        <>
            {actions.paywalled ? (
                <Banner tone="warning" icon="Lock">
                    {t('datatables.share_paywalled', 'Sharing a datatable with colleagues is part of a paid plan. Your own tables, and every table already shared with you, keep working exactly as they do now.')}
                </Banner>
            ) : null}
            {actions.error ? <Banner tone="error">{t('datatables.err_sharing', 'Could not update sharing')}</Banner> : null}
            <Section title={t('datatables.share_read_title', 'Who can read the rows')}>
                <Card padded={false}>
                    <OptionRow label={t('datatables.share_private', 'Private')} description={t('datatables.share_private_desc', 'Only you and the people you invite.')} selected={actions.audience === 'private'} disabled={off} onPress={() => actions.chooseAudience('private')} testID="audience-private" />
                    <OptionRow label={t('datatables.share_org', 'Entire organisation')} description={t('datatables.share_org_desc', 'Everyone can read; only invited people can edit.')} selected={actions.audience === 'org'} disabled={off} onPress={() => actions.chooseAudience('org')} testID="audience-org" />
                    <OptionRow
                        label={t('datatables.share_groups', 'Specific groups')}
                        description={actions.audience === 'groups' ? joinNames(t, table.sharedGroups.map(groupName)) : t('datatables.share_groups_desc', 'Only members of the groups you pick.')}
                        selected={actions.audience === 'groups'}
                        disabled={off}
                        onPress={() => setSheet('groups')}
                        testID="audience-groups"
                    />
                    <ToggleRow
                        label={t('datatables.share_write_toggle', 'Let everyone who can read it change it too')}
                        description={t('datatables.share_write_help', 'Off by default. With this off, only the people you invite below can add, change or delete rows.')}
                        value={table.writeMode === 'audience'}
                        onValueChange={(open) => actions.setWriteOpen(open, access.readers)}
                        disabled={off}
                    />
                </Card>
                <Banner tone={access.broad ? 'warning' : 'info'} icon={access.broad ? 'ShieldAlert' : 'ShieldCheck'}>
                    {`${access.readers} ${t('datatables.can_read_every_row', 'can read every row.')}\n${t('datatables.rows_changed_by', 'Rows can be added, changed and deleted by')} ${access.writers}.${access.broad ? `\n${t('datatables.widest_setting', 'That is the widest setting there is: anyone in your organisation can delete every row, and any automation they run can too.')}` : ''}`}
                </Banner>
            </Section>
            <GrantsSection table={table} canEdit={canEdit} directory={directory} onAdd={() => setSheet('grant')} onPaywalled={() => actions.setPaywalled(true)} />
            {sheet === 'groups' ? (
                <GroupPickerSheet
                    directory={directory}
                    current={table.sharedGroups}
                    onClose={() => setSheet(null)}
                    onApply={(ids) => {
                        setSheet(null);
                        actions.applyGroups(ids);
                    }}
                />
            ) : null}
            {sheet === 'grant' ? <GrantSheet tableId={table.id} directory={directory} onPaywalled={() => actions.setPaywalled(true)} onClose={() => setSheet(null)} /> : null}
        </>
    );
}
