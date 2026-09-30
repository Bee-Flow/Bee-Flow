/**
 * Access & features — the web's AccessPermissionsPanel for an org admin:
 * "Grants" (GroupAccessMatrix) and "Ceiling" (CeilingReadOnly). The matrix
 * of groups × capabilities is a list of capabilities here, grouped by kind,
 * each saying who holds it and opening its own screen to change that.
 *
 * `kind` narrows the list: the org Integrations screen links here with
 * `?kind=integration`, the way the web's Integrations tab mounts the matrix
 * with `kinds=['integration']`. Without it every kind is listed.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryScreen } from '@/shared/patterns';
import { FilterPills, ScreenHeader, Segmented, Text, type FilterPillOption } from '@/shared/ui';

import { CeilingList, GrantsList } from '../components/CapabilityLists';
import { LockedScreen } from '../components/LockedScreen';
import { useGroupAccess } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import {
    CAPABILITY_KINDS,
    ceilingByKind,
    holdersSummary,
    isCapabilityKind,
    isLocked,
    kindLabel,
    sectionsByKind,
} from '../model/access';
import type { CapabilityKind, GroupAccess } from '../model/types';

type Tab = 'grants' | 'ceiling';
type KindFilter = 'all' | CapabilityKind;

function AccessBody({ access, initialKind }: { access: GroupAccess; initialKind: KindFilter }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [tab, setTab] = useState<Tab>('grants');
    const [kind, setKind] = useState<KindFilter>(initialKind);

    const tabs = [
        { value: 'grants' as const, label: t('mobile.orgPeople.grants', 'Grants') },
        { value: 'ceiling' as const, label: t('mobile.orgPeople.ceiling', 'Plan ceiling') },
    ];
    const kinds: FilterPillOption<KindFilter>[] = [
        { value: 'all', label: t('mobile.orgPeople.kind_all', 'All') },
        ...CAPABILITY_KINDS.map((k) => ({ value: k, label: kindLabel(k, t) })),
    ];
    const intro =
        tab === 'grants'
            ? t(
                  'mobile.orgPeople.grants_intro',
                  'A member gets a capability when it is granted to all members or to any group they belong to. Locked items are outside your organisation’s access.',
              )
            : t(
                  'mobile.orgPeople.ceiling_intro',
                  'These are the capabilities your organisation has access to, within your subscription plan or licence. Distribute them under Grants.',
              );

    const header = (
        <View style={styles.head}>
            <Segmented options={tabs} value={tab} onChange={setTab} fullWidth />
            {tab === 'grants' ? <FilterPills scroll value={kind} onChange={setKind} options={kinds} /> : null}
            <Text variant="caption" tone="tertiary">
                {intro}
            </Text>
            {tab === 'grants' && access.betaGoverned ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.orgPeople.beta_governed', 'Beta features follow your subscription.')}
                </Text>
            ) : null}
        </View>
    );

    if (tab === 'ceiling') {
        const sections = ceilingByKind(access).map((s) => ({ title: kindLabel(s.kind, t), data: s.data }));
        return <CeilingList sections={sections} header={header} />;
    }
    const sections = sectionsByKind(access.capabilities, kind === 'all' ? CAPABILITY_KINDS : [kind]).map((s) => ({
        title: kindLabel(s.kind, t),
        data: s.data.map((cap) => ({ cap, summary: holdersSummary(access, cap, t), locked: isLocked(access, cap.id) })),
    }));
    return <GrantsList sections={sections} header={header} />;
}

export function AccessScreen({ kind }: { kind?: string }) {
    const t = useTranslation();
    const { orgId, isOrgAdmin } = usePeopleAccess();
    const access = useGroupAccess(orgId, isOrgAdmin);
    const title = t('mobile.org.section_access', 'Access & features');
    if (!isOrgAdmin || !orgId) return <LockedScreen title={title} />;
    return (
        <QueryScreen query={access} scroll={false} header={() => <ScreenHeader title={title} />}>
            {(data) => <AccessBody access={data} initialKind={isCapabilityKind(kind) ? kind : 'all'} />}
        </QueryScreen>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        head: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing.sm },
    });
