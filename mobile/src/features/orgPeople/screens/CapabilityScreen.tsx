/**
 * One capability: who may use it. "All members" and then each group, as the
 * web's matrix column for this capability. A switch sends the scope's WHOLE
 * grant list with the one change (the PUT replaces it across every kind); a
 * group that has it because everyone has it shows it on and fixed. Outside
 * the organisation's access menu everything is locked, read-only.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryScreen } from '@/shared/patterns';
import { Banner, EmptyState, Group, InsetDivider, ScreenHeader, Text, ToggleRow, useToast } from '@/shared/ui';

import { LockedScreen } from '../components/LockedScreen';
import { useSetGrants } from '../hooks/policyMutations';
import { useGroupAccess } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { everyoneState, groupState, isGoverned, isLocked, kindLabel, withGrant } from '../model/access';
import type { Capability, GroupAccess } from '../model/types';

interface GroupToggle {
    id: string;
    label: string;
    description?: string;
    on: boolean;
    readOnly: boolean;
    toggle: (next: boolean) => void;
}

const renderGroup: ListRenderItem<GroupToggle> = ({ item }) => (
    <ToggleRow
        testID={`grant-group-${item.id}`}
        label={item.label}
        description={item.description}
        value={item.on}
        disabled={item.readOnly}
        onValueChange={item.toggle}
    />
);
const keyOf = (item: GroupToggle) => item.id;

function CapabilityBody({ access, cap, orgId }: { access: GroupAccess; cap: Capability; orgId: string }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const setGrants = useSetGrants(orgId);
    const onError = (e: unknown) => toast(describeError(e).message, 'error');
    const everyone = everyoneState(access, cap);

    const groups: GroupToggle[] = access.groups.map((g) => {
        const state = groupState(access, cap, g.id);
        return {
            id: g.id,
            label: g.name || g.id,
            description: state.inherited ? t('mobile.orgPeople.granted_to_all', 'Granted to all members') : undefined,
            on: state.checked,
            readOnly: state.readOnly,
            toggle: (on: boolean) =>
                setGrants.mutate(
                    { scope: { kind: 'group', groupId: g.id }, granted: withGrant(g.granted, cap.id, on) },
                    { onError },
                ),
        };
    });

    const header = (
        <View style={styles.head}>
            {cap.description ? <Text variant="body" tone="secondary">{cap.description}</Text> : null}
            {isLocked(access, cap.id) ? (
                <Banner tone="info" icon="Lock">
                    {t(
                        'mobile.orgPeople.cap_locked',
                        'Outside your organisation’s access: your plan or licence does not include it, so it cannot be granted here.',
                    )}
                </Banner>
            ) : null}
            {isGoverned(access, cap) ? (
                <Banner tone="info">{t('mobile.orgPeople.beta_governed', 'Beta features follow your subscription.')}</Banner>
            ) : null}
            <Group>
                <ToggleRow
                    testID="grant-everyone"
                    label={t('mobile.orgPeople.all_members', 'All members')}
                    description={t('mobile.orgPeople.all_members_hint', 'Every member has it, whatever their groups.')}
                    value={everyone.checked}
                    disabled={everyone.readOnly}
                    onValueChange={(on) =>
                        setGrants.mutate(
                            { scope: { kind: 'everyone' }, granted: withGrant(access.everyone, cap.id, on) },
                            { onError },
                        )
                    }
                />
            </Group>
            <Text variant="label" tone="tertiary">
                {`${t('admin.org_assign_groups_title', 'Groups').toUpperCase()} · ${groups.length}`}
            </Text>
        </View>
    );

    return (
        <FlatList
            data={groups}
            renderItem={renderGroup}
            keyExtractor={keyOf}
            ItemSeparatorComponent={InsetDivider}
            ListHeaderComponent={header}
            ListEmptyComponent={
                <EmptyState
                    icon="Users"
                    title={t('admin.org_no_groups', 'No groups yet')}
                    message={t('mobile.orgPeople.no_groups_to_grant_message', 'Make a group to grant this to one team only.')}
                    actionLabel={t('admin.org_new_group', 'Create New Group')}
                    onAction={() => router.push('/org/groups')}
                />
            }
            contentContainerStyle={styles.content}
        />
    );
}

export function CapabilityScreen({ id }: { id: string }) {
    const t = useTranslation();
    const { orgId, isOrgAdmin } = usePeopleAccess();
    const access = useGroupAccess(orgId, isOrgAdmin);
    const title = t('mobile.org.section_access', 'Access & features');
    if (!isOrgAdmin || !orgId) return <LockedScreen title={title} />;

    const cap = access.data?.capabilities.find((c) => c.id === id);
    const query = { ...access, data: access.data && cap ? { access: access.data, cap } : undefined };
    return (
        <QueryScreen
            query={query}
            scroll={false}
            header={(d) => <ScreenHeader title={d?.cap.name || title} subtitle={d ? kindLabel(d.cap.kind, t) : undefined} />}
        >
            {(d) => <CapabilityBody access={d.access} cap={d.cap} orgId={orgId} />}
        </QueryScreen>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        head: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing.md },
        content: { paddingBottom: theme.spacing.xxl },
    });
