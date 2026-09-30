/**
 * The drawer on the Studio tab — the web's StudioRail, which REPLACES the
 * workspace sidebar on /app/studio*: a way back to Chat, the "Studio" line,
 * Start (the hub) and Search, then Studio's destinations — the Workspace group
 * and, for a builder, every section under its heading with its count or its
 * lock — and Approvals set apart below them, as on the rail.
 *
 * The groups are features/studio's studioMenuGroups over the same Workspace
 * links and resolved sections the Studio hub draws, so the menu and the hub
 * cannot list different things or gate them differently. A row is its name
 * and nothing else (the rail's rule); a locked row keeps its reason.
 *
 * A plain ScrollView: the list is bounded by the Studio registry.
 */

import React from 'react';
import { ScrollView, View, type TextStyle, type ViewStyle } from 'react-native';

import { lockHint } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { sectionTarget, studioMenuGroups, useStudioCounts, type StudioMenuRow } from '@/features/studio';
import { kindColor, NavRow, SectionLabel, Text } from '@/shared/ui';

import { ApprovalsEntry } from './CoreNav';
import { useDrawerActions } from '../hooks/drawerActions';
import { useDrawerView } from '../hooks/drawerView';
import { useWorkspaceLinks } from '../hooks/useWorkspaceLinks';

const STUDIO_HOME = '/studio';
const NOOP = () => {};

function MenuRow({ row, counts }: { row: StudioMenuRow; counts: Readonly<Record<string, number>> | undefined }) {
    const theme = useTheme();
    const t = useTranslation();
    const { open } = useDrawerActions();
    if (row.kind === 'link') {
        const { link } = row;
        return (
            <NavRow
                label={link.label}
                icon={link.icon}
                count={link.count}
                onPress={() => open({ kind: 'route', href: link.href })}
                testID={`drawer-studio-${link.id}`}
            />
        );
    }
    const { section } = row;
    const hint = section.locked ? lockHint(section.locked, t) : undefined;
    return (
        <NavRow
            label={t(section.labelKey, section.labelFallback)}
            icon={section.icon}
            iconColor={section.kind ? kindColor(theme, section.kind) : undefined}
            count={section.locked ? null : counts?.[section.countKey]}
            countStyle="plain"
            locked={Boolean(section.locked)}
            description={hint}
            accessibilityHint={hint}
            onPress={section.locked ? NOOP : () => open(sectionTarget(section))}
            testID={`drawer-studio-${section.id}`}
        />
    );
}

export function StudioMenu() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { studio } = useDrawerView();
    const { go, push } = useDrawerActions();
    const workspace = useWorkspaceLinks();
    const counts = useStudioCounts(studio.canSee).data?.counts;
    const groups = studioMenuGroups({ workspace, groups: studio.groups, builder: studio.canSee });
    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} testID="drawer-studio-menu">
            <View style={styles.top} accessibilityRole="menu">
                <NavRow label={t('studio.rail.back_to_chat', 'Chat')} icon="ArrowLeft" onPress={() => go('/')} testID="drawer-back-to-chat" />
                <Text variant="subheading" weight="semibold" accessibilityRole="header" style={styles.title} numberOfLines={1}>
                    {t('studio.sidebar_link', 'Studio')}
                </Text>
                <NavRow label={t('studio.start.title', 'Start')} icon="House" active onPress={() => go(STUDIO_HOME)} testID="drawer-studio-start" />
                {studio.canSee ? (
                    <NavRow label={t('studio.rail.search', 'Search…')} icon="Search" onPress={() => push('/studio/search')} testID="drawer-studio-search" />
                ) : null}
            </View>
            {groups.map((group) => (
                <View key={group.id} style={styles.group}>
                    <SectionLabel label={t(group.labelKey, group.labelFallback)} />
                    {group.rows.map((row) => (
                        <MenuRow key={row.id} row={row} counts={counts} />
                    ))}
                </View>
            ))}
            <View style={styles.approvals}>
                <ApprovalsEntry />
            </View>
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) => ({
    scroll: { flex: 1 } satisfies ViewStyle,
    content: { paddingHorizontal: theme.spacing[2], paddingTop: theme.spacing[3], paddingBottom: theme.spacing[4] } satisfies ViewStyle,
    top: { gap: theme.spacing[1] } satisfies ViewStyle,
    title: { color: theme.colors.textPrimary, paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[2] } satisfies TextStyle,
    group: { marginTop: theme.spacing[2], gap: theme.spacing[0.5] } satisfies ViewStyle,
    approvals: { marginTop: theme.spacing[2] } satisfies ViewStyle,
});
