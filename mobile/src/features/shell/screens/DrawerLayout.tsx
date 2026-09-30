/**
 * The drawer navigator (rendered by app/(drawer)/_layout.tsx): the web
 * sidebar as a native drawer over the tabs — 288dp wide (the web's w-72), the
 * sidebar's bgSecondary with its subtle right border, a black 50% scrim
 * (bg-black/50), opened by the header toggle or a swipe from the left edge.
 *
 * Only the tabs live inside it. Every other screen is pushed by the root
 * Stack over the whole drawer, so Back from a chat returns to the tab it was
 * opened from and the drawer never sits under a detail screen.
 */

import { Drawer, getDrawerStatusFromState, type DrawerContentComponentProps } from 'expo-router/drawer';
import React from 'react';
import { StyleSheet } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { DrawerContent } from '../components/DrawerContent';
import { tabPathOf } from '../model/tabs';

/** The web sidebar's open width. */
export const DRAWER_WIDTH = 288;

// The current tab comes from the drawer's OWN state, not the global pathname:
// a screen pushed over the drawer changes the pathname, never this.
const renderContent = ({ navigation, state }: DrawerContentComponentProps) => (
    <DrawerContent navigation={navigation} path={tabPathOf(state)} open={getDrawerStatusFromState(state) !== 'closed'} />
);

export function DrawerLayout() {
    const theme = useTheme();
    return (
        <Drawer
            drawerContent={renderContent}
            screenOptions={{
                headerShown: false,
                drawerType: 'front',
                drawerStyle: {
                    width: DRAWER_WIDTH,
                    backgroundColor: theme.colors.bgSecondary,
                    borderRightWidth: StyleSheet.hairlineWidth,
                    borderRightColor: theme.colors.borderSubtle,
                },
                overlayColor: 'rgba(0, 0, 0, 0.5)',
                swipeEnabled: true,
                swipeEdgeWidth: 32,
                sceneStyle: { backgroundColor: theme.colors.bgPrimary },
            }}
        >
            <Drawer.Screen name="(tabs)" />
        </Drawer>
    );
}
