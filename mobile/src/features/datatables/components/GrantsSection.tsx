/**
 * "People and teams" — the invitations by name, with the owner at the foot.
 * Tapping one offers its two grades and Remove. Removing is never licence-
 * gated; granting and re-grading are (a 402 is reported to the tab). Any
 * other failed re-grade is said in a toast: the menu has already closed, and
 * the badge keeps the old grade.
 *
 * The owner row is not a control: ownership is not a grade you can hand over
 * from here.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ActionMenu, Badge, Button, DataList, ErrorState, Section, Text, useToast, type DataColumn } from '@/shared/ui';

import { useDatatableGrants } from '../hooks/queries';
import { useAddGrant, useRemoveGrant } from '../hooks/sharingMutations';
import { isPaywall } from '../hooks/useSharingActions';
import type { Datatable, Directory, Grant } from '../model/types';

type Row = Grant | { id: 'owner'; owner: true };

export function GrantsSection({
    table,
    canEdit,
    directory,
    onAdd,
    onPaywalled,
}: {
    table: Datatable;
    canEdit: boolean;
    directory: Directory | undefined;
    onAdd: () => void;
    onPaywalled: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const grants = useDatatableGrants(table.id);
    const regrade = useAddGrant(table.id);
    const remove = useRemoveGrant(table.id);
    const [open, setOpen] = useState<Grant | null>(null);
    const nameOf = (type: Grant['granteeType'], id: string | null) => {
        const list = type === 'user' ? directory?.users : directory?.groups;
        return list?.find((x) => x.id === id)?.name || id || t('datatables.owner_unknown', 'The owner');
    };
    const onError = (err: Error) => (isPaywall(err) ? onPaywalled() : toast(describeError(err).message, 'error'));

    const columns: DataColumn<Row>[] = [
        {
            id: 'who',
            label: t('forms.share.audience_who', 'Who'),
            flex: 2,
            render: (r) => ('owner' in r ? nameOf('user', table.ownerUserId) : nameOf(r.granteeType, r.granteeId)),
        },
        {
            id: 'grade',
            label: t('mobile.datatables.may', 'May'),
            flex: 1.3,
            align: 'right',
            render: (r) =>
                'owner' in r ? (
                    <Badge label={t('datatables.owner_grade', 'Owner')} tone="accent" />
                ) : (
                    <Badge label={r.grade === 'editor' ? t('datatables.grade_can_write', 'can change rows') : t('datatables.grade_can_read', 'can read rows')} />
                ),
        },
    ];

    if (grants.isError) return <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />;
    const rows: Row[] = [...(grants.data ?? []), { id: 'owner', owner: true }];

    return (
        <Section title={t('datatables.grants_title', 'People and teams')} subtitle={t('datatables.grants_caption', 'invited by name')}>
            <DataList
                virtualized={false}
                columns={columns}
                rows={rows}
                onRowPress={canEdit ? (r) => ('owner' in r ? undefined : setOpen(r)) : undefined}
                testID="grants"
            />
            {canEdit ? <Button variant="secondary" iconName="Plus" label={t('datatables.grant_add_open', 'Add a person or team')} onPress={onAdd} testID="grant-add" /> : null}
            {remove.error ? (
                <Text variant="caption" tone="error">
                    {t('datatables.err_grant_remove', 'Could not remove the share')}
                </Text>
            ) : null}
            <ActionMenu
                visible={open !== null}
                onClose={() => setOpen(null)}
                title={open ? nameOf(open.granteeType, open.granteeId) : undefined}
                items={
                    open
                        ? [
                              { id: 'viewer', label: t('datatables.grade_can_read', 'can read rows'), selected: open.grade === 'viewer', onPress: () => regrade.mutate({ ...open, grade: 'viewer' }, { onError }) },
                              { id: 'editor', label: t('datatables.grade_can_write', 'can change rows'), selected: open.grade === 'editor', onPress: () => regrade.mutate({ ...open, grade: 'editor' }, { onError }) },
                              { id: 'remove', label: t('datatables.grant_remove', 'Remove {name}', { name: nameOf(open.granteeType, open.granteeId) }), icon: 'Trash2', destructive: true, onPress: () => remove.mutate(open.id) },
                          ]
                        : []
                }
            />
        </Section>
    );
}
