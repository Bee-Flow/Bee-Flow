/**
 * The navigation drawer — the web Sidebar (agent-hub/src/components/shell/
 * Sidebar.jsx) as a native drawer: header, the pinned core rows, one
 * scrolling list (secondary nav, Projects, My Agents, the chats by date) and
 * the profile footer. Rendered by the drawer layout as `drawerContent`.
 *
 * On the Studio tab the middle is Studio's menu instead (StudioMenu), as the
 * web's StudioRail replaces the sidebar on /app/studio*; model/drawerMenu
 * decides which. The header and the footer stay.
 *
 * The drawer is mounted the whole time the app runs, hidden or not, so what
 * it subscribes to matters: it re-renders for the tab it holds and for its
 * own open state (both from its navigator, DrawerLayout), and for access.
 * The global pathname — which moves on every push and pop anywhere — is read
 * only by CloseWhenCovered, which renders nothing.
 */

import { usePathname } from 'expo-router';
import React, { useEffect } from 'react';
import { type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useStudioNav } from '@/features/studio';

import { CoreNav } from './CoreNav';
import { DrawerBody } from './DrawerBody';
import { DrawerHeader } from './DrawerHeader';
import { ProfileFooter } from './ProfileFooter';
import { StudioMenu } from './StudioMenu';
import { DrawerActionsProvider, useDrawerActions } from '../hooks/drawerActions';
import { DrawerViewProvider } from '../hooks/drawerView';
import { drawerMenuFor } from '../model/drawerMenu';
import { TAB_PATHS } from '../model/tabs';

export interface DrawerContentProps {
    /** The drawer navigator's handle (DrawerContentComponentProps['navigation']). */
    navigation: { closeDrawer: () => void };
    /** The tab the drawer holds (model/tabs.tabPathOf). */
    path?: string;
    /** Whether the drawer is open (or opening). */
    open?: boolean;
}

/**
 * A screen pushed over the drawer by anything but a drawer row — the bell, a
 * notification, a link — closes it underneath, so Back returns to the tab,
 * not to a drawer still hanging open.
 */
function CloseWhenCovered() {
    const { close } = useDrawerActions();
    const pathname = usePathname() || '/';
    useEffect(() => {
        if (!TAB_PATHS.has(pathname)) close();
    }, [pathname, close]);
    return null;
}

export function DrawerContent({ navigation, path = '/', open = true }: DrawerContentProps) {
    const styles = useThemedStyles(makeStyles);
    const studio = useStudioNav();
    const close = () => navigation.closeDrawer();

    return (
        <DrawerActionsProvider close={close}>
            <DrawerViewProvider studio={studio} path={path} open={open}>
                <CloseWhenCovered />
                <SafeAreaView edges={['top', 'bottom']} style={styles.root} testID="drawer">
                    <DrawerHeader />
                    {drawerMenuFor(path) === 'studio' ? (
                        <StudioMenu />
                    ) : (
                        <>
                            <CoreNav />
                            <DrawerBody />
                        </>
                    )}
                    <ProfileFooter />
                </SafeAreaView>
            </DrawerViewProvider>
        </DrawerActionsProvider>
    );
}

const makeStyles = (theme: Theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.bgSecondary } satisfies ViewStyle,
});
