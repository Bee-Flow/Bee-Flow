/**
 * The drawer's pinned rows — the web Sidebar's coreNav minus Cowork: New
 * Chat, Approvals (only for someone who takes part in approvals, with how many
 * wait on them), Search. Cowork opens from Studio's Workspace group on the
 * phone (features/shell/hooks/useWorkspaceLinks).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { hasLicenseFeature, holds } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useApprovals } from '@/features/approvals';
import { NavRow } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';
import { useDrawerView } from '../hooks/drawerView';
import { coreSpec, type CoreKey } from '../model/nav';

function Row({ which, active, count, onPress }: { which: CoreKey; active?: boolean; count?: number; onPress: () => void }) {
    const t = useTranslation();
    const spec = coreSpec(which);
    return (
        <NavRow
            label={t(spec.labelKey, spec.labelFallback)}
            icon={spec.icon}
            active={active}
            count={count}
            onPress={onPress}
            testID={`drawer-${which}`}
        />
    );
}

/**
 * Mounted only for someone the licence and their role let browse approvals,
 * so nobody else pays for the reads. The row shows once they take part in ANY
 * approval — the decided ones are a record people look for — and its badge
 * counts only what waits on them (the web's useApprovalsNav).
 *
 * An organisation administrator whose own inbox is empty still gets the row
 * when the ORGANISATION has approvals: taking it away would hide the org's
 * record from the one person entitled to read it. Asked only after the
 * personal answer came back empty, and the row then opens on that record.
 */
function ApprovalsRow({ orgAdmin }: { orgAdmin: boolean }) {
    const { go } = useDrawerActions();
    const pending = useApprovals('pending', { staleTime: 30_000, retry: 1, poll: true });
    const all = useApprovals('all', { staleTime: 60_000, retry: 1 });
    const waiting = pending.data?.length ?? 0;
    const mine = waiting > 0 || (all.data?.length ?? 0) > 0;
    // A 403 (the role no longer carries the org scope) leaves the personal answer as the whole answer.
    const org = useApprovals('org', { staleTime: 5 * 60_000, retry: false, enabled: orgAdmin && all.isSuccess && !mine });
    const theirs = !mine && (org.data?.length ?? 0) > 0;
    if (!mine && !theirs) return null;
    return <Row which="approvals" count={waiting} onPress={() => go(theirs ? '/approvals?scope=org' : coreSpec('approvals').href)} />;
}

/**
 * The Approvals row wherever the drawer draws one — the chat menu's pinned
 * rows and, as on the web's StudioRail, the Studio menu.
 */
export function ApprovalsEntry() {
    const { access } = useDrawerView();
    // Licence says the installation sells approvals; use_approvals says this
    // person handles them. Deliberately not a builder gate: deciding is a
    // member act.
    const canBrowseApprovals = hasLicenseFeature(access, 'approvals') && holds(access, 'use_approvals');
    return canBrowseApprovals ? <ApprovalsRow orgAdmin={access.isOrgAdmin} /> : null;
}

export function CoreNav() {
    const styles = useThemedStyles(makeStyles);
    const { path } = useDrawerView();
    const { go } = useDrawerActions();
    return (
        <View style={styles.nav} accessibilityRole="menu">
            <Row which="new-chat" active={path === '/'} onPress={() => go(coreSpec('new-chat').href)} />
            <ApprovalsEntry />
            <Row which="search" onPress={() => go(coreSpec('search').href)} />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    nav: { paddingHorizontal: theme.spacing[2], paddingTop: theme.spacing[3], gap: theme.spacing[1] } satisfies ViewStyle,
});
