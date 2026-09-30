/**
 * Who may see a Studio object — the web's VisibilityCapsule
 * (agent-hub shared/VisibilityCapsule.jsx) as a sheet: Personal, Entire
 * organisation, or specific groups.
 *
 * Props only: the caller reads the groups (`/auth/groups`) and saves the
 * answer through its own route, because a skill and a knowledge base publish
 * through different endpoints with different rules.
 *
 * Widening — leaving Personal — asks first, as the web's `confirmWidening`
 * does; a narrowing (org → one group, unticking) never asks. Sharing reaches
 * people who could not see the thing a second ago, and that is the one change
 * here nobody can take back once they have read it.
 *
 * `groups: null` is "the list could not be read" and says so. It is never
 * drawn as "this organisation has no groups" — that sentence is a claim, and
 * a failed read cannot make it.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Button, OptionRow, Sheet, Spinner, Text, ToggleRow } from '@/shared/ui';

import { useConfirm, type ConfirmFn } from './confirm';

export interface Audience {
    isShared: boolean;
    sharedGroups: string[];
}

export interface AudienceSheetProps {
    visible: boolean;
    onClose: () => void;
    /** The object's name, for the widening question. */
    name: string;
    value: Audience;
    /** The org's groups; null when the read failed. */
    groups: readonly { id: string; name: string }[] | null;
    /** The groups are still being read: claim nothing about them yet. */
    groupsLoading?: boolean;
    onRetryGroups?: () => void;
    /** False without an organisation: there is nobody to share with. */
    canShare: boolean;
    onChange: (next: Audience) => void;
}

function widening(t: TranslateFn, name: string, groups: string[] | null) {
    return {
        title: t('visibility.confirm_title', 'Share more widely?'),
        message: groups
            ? t('visibility.confirm_groups', 'Members of {groups} will be able to see and use “{name}”.', {
                  groups: groups.join(', '),
                  name,
              })
            : t('visibility.confirm_org', 'Everyone in your organisation will be able to see and use “{name}”.', { name }),
        confirmLabel: t('visibility.confirm_share', 'Share'),
        tone: 'primary' as const,
    };
}

async function toggleGroup(p: AudienceSheetProps, confirm: ConfirmFn, t: TranslateFn, group: { id: string; name: string }) {
    const has = p.value.sharedGroups.includes(group.id);
    const next = has ? p.value.sharedGroups.filter((g) => g !== group.id) : [...p.value.sharedGroups, group.id];
    // Only leaving Personal widens: ticking a group while the whole org can
    // see it narrows, as does unticking (the web's useAudienceActions rule).
    const widens = !has && !p.value.isShared;
    if (widens && !(await confirm(widening(t, p.name, [group.name])))) return;
    if (next.length === 0) p.onChange({ isShared: false, sharedGroups: [] });
    else p.onChange({ isShared: true, sharedGroups: next });
}

function GroupRows({ p, t, confirm }: { p: AudienceSheetProps; t: TranslateFn; confirm: ConfirmFn }) {
    if (p.groupsLoading) return <Spinner />;
    if (p.groups === null) {
        return (
            <>
                <Text variant="caption" tone="warning">
                    {t(
                        'visibility.groups_unreadable',
                        'The list of groups could not be read, so sharing with specific groups is not offered right now. That is not “this organisation has no groups”.',
                    )}
                </Text>
                {p.onRetryGroups ? (
                    <Button label={t('visibility.groups_retry', 'Try again')} variant="secondary" size="sm" onPress={p.onRetryGroups} />
                ) : null}
            </>
        );
    }
    if (p.groups.length === 0) {
        return (
            <Text variant="caption" tone="tertiary">
                {t('visibility.no_groups_available', 'No groups in this organisation yet.')}
            </Text>
        );
    }
    return (
        <>
            {p.groups.map((group) => (
                <ToggleRow
                    key={group.id}
                    gutter={false}
                    label={group.name || group.id}
                    value={p.value.isShared && p.value.sharedGroups.includes(group.id)}
                    onValueChange={() => void toggleGroup(p, confirm, t, group)}
                />
            ))}
        </>
    );
}

export function AudienceSheet(p: AudienceSheetProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const personal = !p.value.isShared;
    const entireOrg = p.value.isShared && p.value.sharedGroups.length === 0;
    const toOrg = async () => {
        if (entireOrg) return;
        if (personal && !(await confirm(widening(t, p.name, null)))) return;
        p.onChange({ isShared: true, sharedGroups: [] });
    };
    return (
        <Sheet visible={p.visible} onClose={p.onClose} title={t('visibility.title', 'Publish to…')} subtitle={t('visibility.choose_who', 'Choose who can see this.')}>
            <OptionRow
                label={t('visibility.personal', 'Personal')}
                description={t('visibility.personal_desc', 'Only you can access')}
                selected={personal}
                onPress={() => p.onChange({ isShared: false, sharedGroups: [] })}
            />
            <OptionRow
                label={t('visibility.entire_org', 'Entire organisation')}
                description={t('visibility.entire_org_desc', 'All members can access')}
                selected={entireOrg}
                disabled={!p.canShare}
                onPress={() => void toOrg()}
            />
            {p.canShare ? (
                <>
                    <Text variant="label" tone="tertiary">
                        {t('visibility.or_specific_groups', 'Or specific groups')}
                    </Text>
                    <GroupRows p={p} t={t} confirm={confirm} />
                </>
            ) : null}
        </Sheet>
    );
}
