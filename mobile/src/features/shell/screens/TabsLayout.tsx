/**
 * The bottom bar (rendered by app/(drawer)/(tabs)/_layout.tsx): Chat, Studio
 * and, behind its gate, Meeting Notes (model/tabs.ts).
 *
 * The bar's height ADDS `insets.bottom` rather than replacing it: a fixed
 * height makes react-navigation skip the inset, and with edge-to-edge
 * (mandatory from Android 15) the labels sat behind the system navigation.
 *
 * Selection is carried by three signals, none of which depends on a hue: a
 * heavier icon stroke, a heavier label, and a pill behind the icon — so it
 * survives every theme, a custom org accent and colour blindness.
 *
 * Inside the drawer: every header under these tabs shows the drawer toggle
 * (HeaderMenuProvider), which opens the drawer this layout is a screen of.
 */

import { Tabs, useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import React from 'react';
import { StyleSheet, View, type ColorValue, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ACTIVE_STROKE, HeaderMenuProvider, Icon, Text } from '@/shared/ui';

import { useTabOffer } from '../hooks/useTabOffer';
import { TABS, tabShown, type TabSpec } from '../model/tabs';

export function TabsLayout() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const navigation = useNavigation();
    const offer = useTabOffer();
    const menu = { open: () => navigation.dispatch(DrawerActions.openDrawer()) };

    return (
        <HeaderMenuProvider menu={menu}>
            <Tabs
                backBehavior="history"
                screenOptions={{
                    headerShown: false,
                    // Maximum contrast in every theme, rather than an accent whose
                    // luminance is not guaranteed against the bar behind it. The
                    // idle tabs are the caption tier, not textMuted: muted is
                    // 3.6:1 on Night's bar, under AA at the label's 11dp.
                    tabBarActiveTintColor: theme.colors.textPrimary,
                    tabBarInactiveTintColor: theme.colors.textTertiary,
                    tabBarStyle: {
                        backgroundColor: theme.colors.bgSecondary,
                        borderTopColor: theme.colors.borderSubtle,
                        borderTopWidth: StyleSheet.hairlineWidth,
                        // 48dp touch minimum once the label is subtracted, plus the gesture bar.
                        height: 58 + insets.bottom,
                        paddingTop: 6,
                        paddingBottom: insets.bottom,
                    },
                    tabBarItemStyle: { paddingVertical: 0 },
                    tabBarHideOnKeyboard: true,
                    sceneStyle: { backgroundColor: theme.colors.bgPrimary },
                }}
            >
                {TABS.map((tab) => (
                    <Tabs.Screen
                        key={tab.name}
                        name={tab.name}
                        options={{
                            // Hidden from the bar, still routable (a deep link lands).
                            href: tabShown(tab, offer) ? undefined : null,
                            tabBarLabel: ({ focused }) => <TabLabel tab={tab} focused={focused} />,
                            tabBarIcon: ({ color, focused }) => <TabIcon tab={tab} color={color} focused={focused} />,
                        }}
                    />
                ))}
            </Tabs>
        </HeaderMenuProvider>
    );
}

interface TabPartProps {
    tab: TabSpec;
    color: ColorValue;
    focused: boolean;
}

function TabLabel({ tab, focused }: Omit<TabPartProps, 'color'>) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <Text
            variant="label"
            weight={focused ? 'semibold' : 'regular'}
            style={[styles.label, focused ? styles.labelOn : styles.labelOff]}
            numberOfLines={1}
        >
            {t(tab.labelKey, tab.labelFallback)}
        </Text>
    );
}

function TabIcon({ tab, color, focused }: TabPartProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={[styles.pill, focused ? styles.pillOn : null]}>
            <Icon name={tab.icon} size={21} color={color} strokeWidth={focused ? ACTIVE_STROKE : undefined} />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    label: { marginTop: 2 } satisfies TextStyle,
    labelOn: { color: theme.colors.textPrimary } satisfies TextStyle,
    labelOff: { color: theme.colors.textTertiary } satisfies TextStyle,
    // Sized here rather than by padding, so the row's rhythm does not shift a
    // pixel when a tab is selected.
    pill: {
        width: 52,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.pill,
    } satisfies ViewStyle,
    pillOn: { backgroundColor: theme.colors.itemActiveBg } satisfies ViewStyle,
});
