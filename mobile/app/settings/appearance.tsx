/**
 * Appearance.
 *
 * All eight themes, each drawn as a working miniature of the app rather than
 * as a swatch — see components/ThemePreview.tsx for why. Picking one does two
 * things, and both matter:
 *
 *   1. It sets the local preference (ThemeProvider → AsyncStorage), which is
 *      what actually repaints the app, instantly and offline.
 *   2. It writes the same choice to `PUT /api/branding/user`, so the web app
 *      agrees. That call is allowed to fail — an admin can turn user overrides
 *      off (403), and the phone must still let you choose your own theme on
 *      your own device. The screen says so rather than silently diverging.
 *
 * The org's branding accent, when an admin has pinned one, is applied by
 * ThemeProvider on top of whichever palette is chosen, so the previews show
 * it too. That is the honest preview: a Bee Flow with a company accent does
 * not look like stock Bee Flow.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { ScrollView, View } from 'react-native';

import { ApiError } from '../../src/api/client';
import { getBranding, saveUserBranding, settingsKeys } from '../../src/features/settings/api';
import { ThemePreview } from '../../src/features/settings/components/ThemePreview';
import { humanise } from '../../src/features/settings/format';
import { useTheme, type ThemePreference } from '../../src/theme/ThemeProvider';
import { PICKABLE_THEMES, type ThemeName } from '../../src/theme/tokens';
import { Badge } from '../../src/ui/Badge';
import { OptionRow } from '../../src/ui/Controls';
import { Banner } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

/** One line per theme, describing what it is FOR rather than what it is. */
const THEME_COPY: Record<ThemeName, { label: string; description: string }> = {
    dark: { label: 'Dark', description: 'The default. Easy at night.' },
    light: { label: 'Light', description: 'Crisp in daylight.' },
    glass: { label: 'Glass', description: 'Translucent, light ground.' },
    'glass-dark': { label: 'Glass dark', description: 'Translucent, dark ground.' },
    'high-contrast': { label: 'High contrast', description: 'Maximum legibility.' },
    paper: { label: 'Paper', description: 'Warm and low-glare, for reading.' },
    obsidian: { label: 'Obsidian', description: 'Near-black, minimal colour.' },
    sepia: { label: 'Sepia', description: 'Softer than paper, kinder at dusk.' },
};

export default function AppearanceScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();

    const branding = useQuery({
        queryKey: settingsKeys.branding,
        queryFn: ({ signal }) => getBranding(signal),
        staleTime: 5 * 60_000,
    });

    /**
     * Sync the choice to the account.
     *
     * `preset` is the same vocabulary on both sides — the server's brandingStore
     * accepts exactly the eight palette names (plus 'custom', which this app has
     * no palette for and never sends). 'system' has no server equivalent, so it
     * is a device-only choice and simply is not pushed.
     */
    const sync = useMutation({
        mutationFn: (preset: ThemeName) => saveUserBranding({ preset }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: settingsKeys.branding });
        },
    });

    const choose = (preference: ThemePreference) => {
        theme.setPreference(preference);
        if (preference !== 'system') sync.mutate(preference);
    };

    // Two ways to learn the same thing: the server told us up front
    // (allowUserOverride) or it refused the write (403). Either way the local
    // choice still stands — it just stops at this device.
    const overrideRefused =
        (sync.error instanceof ApiError && sync.error.isForbidden) ||
        branding.data?.allowUserOverride === false;

    const orgAccent = branding.data?.accent ?? null;
    const accentIsPinned = Boolean(
        theme.branding.accentColor && branding.data?.source !== 'user',
    );

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Appearance" subtitle="How Bee Flow looks on this phone" />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                {overrideRefused ? (
                    <Banner tone="info" icon="info">
                        Your administrator has fixed the organisation&rsquo;s theme, so your choice
                        stays on this phone and will not follow you to the web app.
                    </Banner>
                ) : null}

                <Group
                    title="Follow the system"
                    footer="Android switches between light and dark on a schedule or with the battery saver. Following it means Bee Flow does too."
                >
                    <OptionRow
                        label="Match my phone"
                        description={
                            theme.preference === 'system'
                                ? `Currently showing ${THEME_COPY[theme.name].label.toLowerCase()}`
                                : 'Light in the day, dark at night'
                        }
                        selected={theme.preference === 'system'}
                        onPress={() => choose('system')}
                        leading={
                            <Feather
                                name="smartphone"
                                size={18}
                                color={theme.colors.textSecondary}
                            />
                        }
                    />
                </Group>

                <View style={{ gap: theme.spacing.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
                        <Text variant="label" tone="tertiary" style={{ flex: 1 }}>
                            OR PICK ONE
                        </Text>
                        {sync.isPending ? (
                            <Text variant="label" tone="tertiary">
                                Saving…
                            </Text>
                        ) : null}
                    </View>

                    {/* Two per row. Three fits, but at three the miniature stops
                        reading as a screen and starts reading as a swatch —
                        which is the thing this screen exists not to be. */}
                    {chunk(PICKABLE_THEMES, 2).map((row, rowIndex) => (
                        <View
                            key={rowIndex}
                            accessibilityRole="radiogroup"
                            style={{ flexDirection: 'row', gap: theme.spacing.md }}
                        >
                            {row.map((name) => (
                                <ThemePreview
                                    key={name}
                                    name={name}
                                    label={THEME_COPY[name].label}
                                    description={THEME_COPY[name].description}
                                    selected={theme.preference === name}
                                    accentOverride={theme.branding.accentColor ?? null}
                                    onPress={() => choose(name)}
                                />
                            ))}
                            {/* Keeps a lone last tile at half width instead of
                                stretching it across the row. */}
                            {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
                        </View>
                    ))}
                </View>

                <Group
                    title="Your organisation's branding"
                    footer={
                        accentIsPinned
                            ? 'The accent colour and corner roundness come from your organisation. Bee Flow re-derives the text colour on top of that accent so a button can never end up unreadable.'
                            : 'Your organisation has not set a brand colour, so Bee Flow uses its own.'
                    }
                >
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.md,
                            paddingHorizontal: theme.spacing.lg,
                            paddingVertical: theme.spacing.md,
                            minHeight: theme.minTouch,
                        }}
                    >
                        <View
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={{
                                width: 28,
                                height: 28,
                                borderRadius: theme.radii.sm,
                                backgroundColor: theme.colors.accentPrimary,
                            }}
                        />
                        <Text variant="body" style={{ flex: 1 }}>
                            Accent colour
                        </Text>
                        <Text variant="body" tone="tertiary" selectable>
                            {(theme.branding.accentColor ?? orgAccent ?? theme.colors.accentPrimary).toUpperCase()}
                        </Text>
                    </View>
                    {branding.data ? (
                        <InfoRow
                            label="Set by"
                            value={
                                branding.data.source === 'user'
                                    ? 'You'
                                    : branding.data.source === 'admin'
                                      ? 'Your administrator'
                                      : 'Bee Flow default'
                            }
                        />
                    ) : null}
                    {theme.branding.appName ? (
                        <InfoRow label="Workspace name" value={theme.branding.appName} />
                    ) : null}
                </Group>

                <Group title="Readability">
                    <NoteRow>
                        <View style={{ gap: theme.spacing.sm }}>
                            <Text variant="body">Text size follows Android</Text>
                            <Text variant="caption" tone="tertiary">
                                Bee Flow honours the display size and font size set in Android&rsquo;s
                                accessibility settings, capped so a dense list stays readable rather
                                than becoming three words per line.
                            </Text>
                            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                <Badge label={`Theme: ${humanise(theme.name)}`} />
                                <Badge
                                    label={theme.dark ? 'Light ink' : 'Dark ink'}
                                    tone={theme.dark ? 'accent' : 'neutral'}
                                />
                            </View>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>
        </Screen>
    );
}

/** Split a readonly list into fixed-size rows for a manual grid. */
function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size) as T[]);
    }
    return out;
}
