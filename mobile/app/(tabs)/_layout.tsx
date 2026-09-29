/**
 * The five tabs.
 *
 * Two things here were actively wrong, and both were invisible in code review
 * because they only show up on a device.
 *
 * **The bar sat under the gesture bar.** A fixed `height: 64` makes
 * react-navigation's BottomTabBar return that height verbatim and skip
 * `insets.bottom` entirely, and because `tabBarStyle` is spread last it also
 * clobbered the library's own `paddingBottom: insets.bottom`. With
 * edge-to-edge on (mandatory from Android 15), the labels sat behind the
 * system navigation. The original intent — a bar tall enough to clear
 * Android's 48dp touch minimum once the label is subtracted — is kept; the
 * inset is now added to it rather than replacing it.
 *
 * **Selected was harder to see than unselected.** The active tint was
 * `accentPrimary` (#9ca3af) and the inactive one `textMuted` (#64748b), so on
 * the light theme's #f3f3f3 bar the selected tab sat at 2.3:1 and every
 * unselected tab at 4.4:1 — the current tab was the faintest thing in the row.
 *
 * The fix is deliberately not "pick a better colour". Selection is now carried
 * by THREE signals, none of which depends on a hue: a filled-vs-outline icon,
 * a heavier label, and a pill behind the icon. That survives every one of the
 * eight themes, a custom org accent, and a colour-blind user. The accent still
 * appears — as the pill's tint — but nothing legible rests on it.
 */

import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../src/theme/ThemeProvider';
import { Text } from '../../src/ui/Text';

/**
 * Ionicons rather than Feather for these five glyphs only: Feather is an
 * outline-only set, so the filled/outline pair that carries selection does not
 * exist in it. Everywhere else in the app stays on Feather.
 */
const TABS = [
    { name: 'index', title: 'Chat', icon: 'chatbubble' },
    { name: 'record', title: 'Record', icon: 'mic' },
    { name: 'library', title: 'Library', icon: 'library' },
    { name: 'cowork', title: 'Cowork', icon: 'people' },
    { name: 'more', title: 'More', icon: 'grid' },
] as const;

export default function TabsLayout() {
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                // Maximum contrast in every theme, rather than an accent whose
                // luminance is not guaranteed against the bar behind it.
                tabBarActiveTintColor: theme.colors.textPrimary,
                tabBarInactiveTintColor: theme.colors.textMuted,
                tabBarStyle: {
                    backgroundColor: theme.colors.bgSecondary,
                    borderTopColor: theme.colors.borderSubtle,
                    borderTopWidth: StyleSheet.hairlineWidth,
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
                        title: tab.title,
                        // Labels stay — icon-only tab bars test badly with
                        // anyone who has not used the app before. Rendered
                        // rather than styled, because the weight has to change
                        // with focus and `tabBarLabelStyle` takes no function.
                        tabBarLabel: ({ color, focused }) => (
                            <Text
                                variant="label"
                                weight={focused ? 'semibold' : 'regular'}
                                style={{ color, marginTop: 2 }}
                                numberOfLines={1}
                            >
                                {tab.title}
                            </Text>
                        ),
                        tabBarIcon: ({ color, focused }) => (
                            <View
                                style={{
                                    // The pill is sized here rather than by
                                    // padding so the row's vertical rhythm does
                                    // not shift by a pixel when a tab is
                                    // selected.
                                    width: 52,
                                    height: 28,
                                    borderRadius: theme.radii.pill,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: focused
                                        ? theme.colors.itemActiveBg
                                        : 'transparent',
                                }}
                            >
                                <Ionicons
                                    name={focused ? tab.icon : (`${tab.icon}-outline` as const)}
                                    size={21}
                                    color={color}
                                />
                            </View>
                        ),
                    }}
                />
            ))}
        </Tabs>
    );
}
