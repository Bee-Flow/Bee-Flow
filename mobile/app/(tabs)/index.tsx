/**
 * The Chat tab — a composer, not a list.
 *
 * This screen used to be the conversation list, with a floating "+" in the
 * corner. Two problems with that, and the owner hit both:
 *
 *   1. It did not look like Bee Flow. The web app's home is a heading, a
 *      composer card and three suggestions; the phone's was a wall of titles.
 *      Same account, same moment, two different products.
 *   2. Starting a chat — the thing the app is for — cost two taps and a hunt
 *      for a FAB, while the list of things you already said cost none.
 *
 * So the composer is the home now and the list moved to `/chats`, one tap away
 * behind a row that says so. RECENT stays here, capped at eight and flat: on a
 * phone, returning to yesterday's thread genuinely competes with starting a new
 * one, and that is the one place this screen departs from the web's (whose home
 * has no list at all — it has a permanent sidebar instead, which a phone
 * cannot afford).
 *
 * The heading and the three suggestions are the WEB's own, ported verbatim in
 * `src/features/chat/prompts.ts` with their `starter.*` i18n keys, so a Dutch
 * account reads "Waar werken we aan?" here exactly as it does in the browser.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { chatKeys, listConversations } from '../../src/features/chat/api';
import { Composer, type ComposerSettings } from '../../src/features/chat/Composer';
import { pickPrompts, pickWelcome } from '../../src/features/chat/prompts';
import { useChatPreferences } from '../../src/features/chat/settingsStore';
import { fetchTiers, tierKeys } from '../../src/features/chat/tiers';
import { useTranslation } from '../../src/i18n';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { ListSkeleton } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Segmented } from '../../src/ui/Segmented';
import { Text } from '../../src/ui/Text';

/** The web shows three. More becomes a menu; fewer stops reading as examples. */
const STARTER_COUNT = 3;
/** Enough to recognise yesterday's work, few enough not to become the list. */
const RECENT_LIMIT = 8;

export default function ChatHomeScreen() {
    const theme = useTheme();
    const router = useRouter();
    const t = useTranslation();
    const { width } = useWindowDimensions();
    const prefs = useChatPreferences();

    // `useState`, not `useMemo`: a re-render must not reshuffle the heading or
    // the suggestions while somebody is reading them. Fresh per mount, which is
    // what the web does.
    const [welcome] = useState(() => pickWelcome());
    const [starters] = useState(() => pickPrompts(STARTER_COUNT));

    const [draft, setDraft] = useState('');
    const [settings, setSettings] = useState<ComposerSettings>({
        modelTier: prefs.modelTier,
        knowledgeBaseIds: [],
        reasoningEffort: null,
        webSearchEnabled: prefs.webSearchEnabled,
    });

    const tiers = useQuery({
        queryKey: tierKeys.forTask('direct_chat'),
        queryFn: ({ signal }) => fetchTiers('direct_chat', signal),
        staleTime: 10 * 60_000,
    });

    const conversations = useQuery({
        queryKey: chatKeys.conversations,
        queryFn: ({ signal }) => listConversations(signal),
    });

    const recent = useMemo(
        () =>
            [...(conversations.data ?? [])]
                .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
                .slice(0, RECENT_LIMIT),
        [conversations.data],
    );

    /**
     * Hand the message to a real conversation.
     *
     * The composer here is the same component the chat screen uses, so the send
     * is a navigation rather than a second implementation of the turn loop:
     * `/chat/new` picks the draft up and sends it on mount.
     */
    const start = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        router.push(`/chat/new?draft=${encodeURIComponent(trimmed)}`);
    };

    return (
        <Screen edges={['top']} avoidKeyboard>
            {/*
              * The web's own element, in the web's own place: a centred
              * Chat | Cowork pill (agent-hub CoworkModeSwitch.jsx). It is the
              * SECOND door to Cowork — the tab is the first — and it is the one
              * that catches the case the switch exists for on the web: you
              * start typing and realise this should run every Monday.
              *
              * It switches tabs rather than swapping this screen's body, so
              * there is exactly one Cowork surface and the tab bar stays honest
              * about where you are.
              */}
            {/*
              * `global={false}`: no magnifier, no bell — the owner asked for
              * them off this one screen so the pill sits at the TRUE centre,
              * which is where the web puts it. They stay in every other
              * header; the home keeps only the one control that must be seen.
              */}
            <ScreenHeader
                size="large"
                title="Chat"
                global={false}
                center={
                    <Segmented
                        accessibilityLabel="Chat or Cowork"
                        value="chat"
                        onChange={(next) => {
                            if (next === 'cowork') router.push('/(tabs)/cowork');
                        }}
                        options={[
                            {
                                value: 'chat',
                                label: t('sidebar.direct_chat', 'Chat'),
                                icon: (
                                    <Feather
                                        name="message-circle"
                                        size={14}
                                        color={theme.colors.textPrimary}
                                    />
                                ),
                            },
                            {
                                value: 'cowork',
                                label: t('sidebar.cowork', 'Cowork'),
                                icon: (
                                    <Feather
                                        name="users"
                                        size={14}
                                        color={theme.colors.textTertiary}
                                    />
                                ),
                            },
                        ]}
                    />
                }
            />

            <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                    flexGrow: 1,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.lg,
                }}
            >
                {/*
                  * The only centring mechanism on this screen. It collapses as
                  * RECENT fills, so an empty account gets the web's centred
                  * heading and a busy one gets its conversations near the top —
                  * without a `justifyContent` that would fight the list.
                  */}
                <View style={{ flex: 1, minHeight: theme.spacing.xl }} />

                <Text
                    style={{
                        // The RN form of the web's clamp(20px, 5vw, 32px).
                        fontSize: Math.min(28, Math.max(20, width * 0.075)),
                        lineHeight: Math.min(34, Math.max(26, width * 0.09)),
                        fontFamily: theme.type.heading.fontFamily,
                        letterSpacing: -0.5,
                        color: theme.colors.textPrimary,
                        textAlign: 'center',
                        marginBottom: theme.spacing.lg + 4,
                    }}
                >
                    {t(welcome.i18nKey, welcome.text)}
                </Text>

                {/*
                  * No subtitle and no icon tile. The web's home has neither,
                  * and the privacy line that used to sit here ("Your data stays
                  * on your own server") is better said where it is live state —
                  * the "Search the web" switch in the "+" sheet, which says
                  * what is actually true of the next question rather than
                  * making a promise underneath a picture.
                  */}
                <View style={{ gap: theme.spacing.sm }}>
                    {starters.map((p) => (
                        <Pressable
                            key={p.i18nKey}
                            onPress={() => setDraft(t(p.i18nKey, p.text))}
                            accessibilityRole="button"
                            accessibilityLabel={t(p.i18nKey, p.text)}
                            accessibilityHint="Puts this in the message box. It does not send."
                            style={({ pressed }) => ({
                                minHeight: 52,
                                borderRadius: theme.radii.lg,
                                backgroundColor: pressed
                                    ? theme.colors.bgCardHover
                                    : theme.colors.bgCard,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: theme.colors.cardBorder,
                                paddingHorizontal: 14,
                                paddingVertical: 10,
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 10,
                            })}
                        >
                            <Text style={{ fontSize: 15 }}>{p.icon}</Text>
                            <Text
                                variant="caption"
                                weight="medium"
                                tone="secondary"
                                numberOfLines={2}
                                style={{ flex: 1 }}
                            >
                                {t(p.i18nKey, p.text)}
                            </Text>
                        </Pressable>
                    ))}
                </View>

                {conversations.isLoading ? (
                    <View style={{ paddingTop: theme.spacing.xl }}>
                        <ListSkeleton rows={3} />
                    </View>
                ) : recent.length > 0 ? (
                    <View style={{ paddingTop: theme.spacing.xl }}>
                        <Text
                            variant="label"
                            tone="tertiary"
                            style={{ paddingBottom: theme.spacing.xs }}
                        >
                            RECENT
                        </Text>
                        {recent.map((item) => (
                            <ListRow
                                key={item.id}
                                title={item.title || 'Untitled chat'}
                                meta={relativeTime(item.updated_at)}
                                leading={
                                    <Feather
                                        name={item.pinned ? 'bookmark' : 'message-circle'}
                                        size={16}
                                        color={
                                            item.pinned
                                                ? theme.colors.accentText
                                                : theme.colors.textMuted
                                        }
                                    />
                                }
                                onPress={() => router.push(`/chat/${item.id}`)}
                            />
                        ))}
                    </View>
                ) : null}

                {/*
                  * Two rows, and the second is the point: /agents had exactly
                  * one inbound link in the whole app — the More tab — so
                  * talking to an agent you had not talked to before cost four
                  * taps. It costs two from here.
                  */}
                <View style={{ paddingTop: theme.spacing.md }}>
                    <ListRow
                        title="All conversations"
                        onPress={() => router.push('/chats')}
                    />
                    <ListRow title="Your agents" onPress={() => router.push('/agents')} />
                </View>
            </ScrollView>

            <Composer
                onSend={start}
                onStop={() => undefined}
                streaming={false}
                settings={settings}
                onSettingsChange={setSettings}
                tiers={tiers.data ?? {}}
                onVoice={() => router.push('/voice')}
                // No autoFocus: raising the keyboard on a cold open would bury
                // RECENT, which is half the reason this screen keeps a list.
                initialText={draft}
                placeholder={t('composer.placeholder', 'Message Bee Flow')}
            />
        </Screen>
    );
}
