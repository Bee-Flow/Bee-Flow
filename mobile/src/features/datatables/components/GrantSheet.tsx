/**
 * "Add a person or team": who, and whether they may only read the rows or
 * change them too. Re-granting someone already on the list changes their grade
 * (the server upserts on table × person).
 */

import React, { useCallback, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Button, Segmented, Sheet } from '@/shared/ui';

import { DirectoryList } from './DirectoryList';
import { useAddGrant } from '../hooks/sharingMutations';
import { isPaywall } from '../hooks/useSharingActions';
import type { Directory, Grant } from '../model/types';

type Kind = Grant['granteeType'];
type GrantGrade = Grant['grade'];

export function GrantSheet({
    tableId,
    directory,
    onPaywalled,
    onClose,
}: {
    tableId: string;
    directory: Directory | undefined;
    onPaywalled: () => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const add = useAddGrant(tableId);
    const [kind, setKind] = useState<Kind>('user');
    const [who, setWho] = useState('');
    const [grade, setGrade] = useState<GrantGrade>('viewer');
    const entries = kind === 'user' ? directory?.users ?? [] : directory?.groups ?? [];
    const isSelected = useCallback((id: string) => id === who, [who]);

    // A 402 is the paid boundary, said on the tab rather than inside this sheet.
    const share = () =>
        add.mutate(
            { granteeType: kind, granteeId: who, grade },
            {
                onSuccess: onClose,
                onError: (err) => {
                    if (!isPaywall(err)) return;
                    onPaywalled();
                    onClose();
                },
            },
        );

    return (
        <Sheet
            visible
            scroll={false}
            onClose={onClose}
            title={t('datatables.grant_add_open', 'Add a person or team')}
            footer={
                <Button
                    fullWidth
                    size="lg"
                    label={t('datatables.share_button', 'Share')}
                    disabled={!who}
                    loading={add.isPending}
                    onPress={share}
                    testID="grant-share"
                />
            }
        >
            {add.error && !isPaywall(add.error) ? (
                <Banner tone="error">{t('datatables.err_grant_add', 'Could not share the table')}</Banner>
            ) : null}
            <Segmented<Kind>
                fullWidth
                value={kind}
                onChange={(next) => {
                    setKind(next);
                    setWho('');
                }}
                accessibilityLabel={t('datatables.grantee_kind', 'A person or a group')}
                options={[
                    { value: 'user', label: t('datatables.grantee_person', 'A person') },
                    { value: 'group', label: t('datatables.grantee_group', 'A group') },
                ]}
            />
            <DirectoryList
                entries={entries}
                isSelected={isSelected}
                onToggle={setWho}
                emptyText={
                    directory && !directory.available
                        ? t('datatables.share_no_directory', 'You cannot see the organisation’s group list, so the groups are shown by id.')
                        : kind === 'user'
                          ? t('datatables.pick_person', 'Pick someone…')
                          : t('datatables.pick_group', 'Pick a group…')
                }
            />
            <Segmented<GrantGrade>
                fullWidth
                value={grade}
                onChange={setGrade}
                accessibilityLabel={t('datatables.grantee_grade', 'What they may do')}
                options={[
                    { value: 'viewer', label: t('datatables.grade_can_read', 'can read rows') },
                    { value: 'editor', label: t('datatables.grade_can_write', 'can change rows') },
                ]}
            />
        </Sheet>
    );
}
