/**
 * The Chat tab — a composer, not a list.
 *
 * Starting a chat — the thing the app is for — should not cost a hunt for a
 * FAB, so the home is a heading over the composer and nothing else. There are
 * no suggestion cards and no RECENT list: the history is the drawer's (and
 * `/chats`), one swipe away, and two lists of the same conversations on two
 * surfaces only pushed the composer's heading off centre.
 *
 * The heading is the WEB's own, ported verbatim in model/prompts.ts with its
 * `starter.*` i18n key, so a Dutch account reads "Waar werken we aan?" here
 * exactly as it does in the browser.
 *
 * The composer settings are the chat screen's own hook, so a tier or web
 * search chosen here is the one the new chat sends with; the attached bases
 * and the brain switch travel in the route, and the attached files are staged
 * for the new chat to send with the words (model/newChat.ts). The composer
 * offers what it can before there is a conversation: dictation, creating
 * media and the apps this chat may reach, as the chat screen does.
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Screen, Text } from '@/shared/ui';

import { Composer, type ComposerExtras } from '../components/composer/Composer';
import { HomeHeader } from '../components/HomeHeader';
import { useComposerSettings } from '../hooks/useComposerSettings';
import { useMediaGates } from '../hooks/useComposerStatus';
import { newChatHref, stageNewChatFiles } from '../model/newChat';
import { pickWelcome } from '../model/prompts';
import type { Attachment } from '../model/types';

const makeStyles = (theme: Theme) => ({
    content: { flexGrow: 1, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
    // Two springs, one above and one below: the heading sits in the middle
    // of whatever the keyboard leaves.
    spring: { flex: 1, minHeight: theme.spacing.xl },
    heading: {
        ...theme.fonts.semibold,
        letterSpacing: -0.5,
        color: theme.colors.textPrimary,
        textAlign: 'center' as const,
    },
});

export function ChatHomeScreen() {
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const t = useTranslation();
    const { width } = useWindowDimensions();
    const composer = useComposerSettings();
    const [memoryEnabled, setMemoryEnabled] = useState(true);
    const memory = useMemo(() => ({ enabled: memoryEnabled, onToggle: () => setMemoryEnabled((v) => !v) }), [memoryEnabled]);
    const mediaGates = useMediaGates();
    const extras = useMemo<ComposerExtras>(() => ({ mediaGates, apps: true, dictation: true }), [mediaGates]);

    // `useState`, not `useMemo`: a re-render must not swap the heading while
    // somebody is reading it. Fresh per mount, as on the web.
    const [welcome] = useState(() => pickWelcome());

    // The composer here is the chat screen's, so sending is a navigation
    // rather than a second turn loop: `/chat/new` sends the draft and the
    // staged files on mount. Files alone are a message too.
    const start = (text: string, attachments: Attachment[]) => {
        const trimmed = text.trim();
        if (!trimmed && !attachments.length) return;
        stageNewChatFiles(attachments);
        router.push(newChatHref(trimmed, composer.settings.knowledgeBaseIds, memoryEnabled));
    };

    return (
        <Screen edges={['top']} avoidKeyboard>
            <HomeHeader />
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                <View style={styles.spring} />
                {/* The RN form of the web's clamp(20px, 5vw, 32px). No subtitle
                    and no icon tile: the web's home has neither. */}
                <Text
                    style={[
                        styles.heading,
                        {
                            fontSize: Math.min(28, Math.max(20, width * 0.075)),
                            lineHeight: Math.min(34, Math.max(26, width * 0.09)),
                        },
                    ]}
                >
                    {t(welcome.i18nKey, welcome.text)}
                </Text>
                <View style={styles.spring} />
            </ScrollView>

            <Composer
                onSend={start}
                onStop={() => undefined}
                streaming={false}
                settings={composer.settings}
                onSettingsChange={composer.onSettingsChange}
                tiers={composer.tiers}
                knowledgeBaseNames={composer.knowledgeBaseNames}
                memory={memory}
                onVoice={() => router.push('/voice')}
                extras={extras}
                // No autoFocus: a keyboard raised on every cold open hides the
                // tab bar and the drawer's edge before anyone asked to type.
                placeholder={t('chat.composer.placeholder_direct', 'Message AI...')}
            />
        </Screen>
    );
}
