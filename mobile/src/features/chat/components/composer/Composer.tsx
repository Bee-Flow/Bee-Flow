/**
 * The composer.
 *
 * This is the most-touched control in the app, so it takes the most care:
 *
 *   - The input grows from one line to six and then scrolls. A fixed-height
 *     box makes people write shorter prompts than they meant to.
 *   - Send and Stop are the SAME button in the same place (SendButton).
 *   - Above the input is a CONTEXT ROW showing only what the assistant will
 *     read — attached knowledge bases, active skills, web search — each chip
 *     tappable to remove, and nothing at all when nothing is on.
 *   - Everything else the composer can do sits behind one ＋ (the web's
 *     tools menu): files, knowledge, skills, web search, creating media, the
 *     apps this chat may reach, voice mode. Beside send: dictation and the
 *     Privacy Shield's claim.
 *   - Attachments are staged as chips above the input and can be removed
 *     before sending (useAttachmentPicker).
 *
 * Memoised: it sits under a screen that changes while an answer streams, and
 * its props are kept stable there so it does not re-render with it.
 */

import * as Haptics from 'expo-haptics';
import React, { memo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAttachmentPicker } from '@/features/chat/hooks/useAttachmentPicker';
import type { ComposerExtras } from '@/features/chat/model/composerExtras';
import { type TierMap } from '@/features/chat/model/tiers';
import { type Attachment, type ComposerSettings } from '@/features/chat/model/types';
import { useActiveSkills } from '@/features/skills';
import { Text } from '@/shared/ui';

import { AttachmentChips } from './AttachmentChips';
import { ComposerPanels, type ComposerPanel } from './ComposerPanels';
import { ComposerToolbar } from './ComposerToolbar';
import { ContextRow } from './ContextRow';
import { ThreadBanner } from './ThreadBanner';

export type { ComposerSettings } from '@/features/chat/model/types';
export type { ComposerExtras } from '@/features/chat/model/composerExtras';

export interface ComposerProps {
    onSend: (text: string, attachments: Attachment[]) => void;
    onStop: () => void;
    streaming: boolean;
    settings: ComposerSettings;
    onSettingsChange: (next: ComposerSettings) => void;
    /** Fetched from /ai/config/tiers-for-user. Empty while loading. */
    tiers: TierMap;
    /** Names for the attached knowledge-base ids, so chips can say which. */
    knowledgeBaseNames?: { id: string; name: string }[];
    /**
     * Whether this surface can attach knowledge bases. False for agent and
     * notebook chats: an agent's sources are configured server-side and a
     * notebook IS its source.
     */
    sources?: boolean;
    /** Opens the voice screen. Absent on surfaces that have no voice mode. */
    onVoice?: () => void;
    /** The memory switch, in the tier dial's panel as on the web (direct chat only). */
    memory?: { enabled: boolean; onToggle: () => void };
    /** Disables everything and explains why — read-only, over quota, locked. */
    disabledReason?: string | null;
    placeholder?: string;
    /** Seeded from a share intent or a "continue this" action. */
    initialText?: string;
    /** Files handed over by Android's share sheet, staged once on mount. */
    initialAttachments?: Attachment[];
    extras?: ComposerExtras;
}

const makeStyles = (theme: Theme) => ({
    shell: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, gap: theme.spacing.sm },
    reason: { paddingHorizontal: theme.spacing.sm },
    // ONE card, the shape the web app uses: the question on its own line and
    // its controls beneath, with the attachment and context chips visibly
    // PART of the message being composed.
    card: {
        backgroundColor: theme.colors.bgCard,
        borderRadius: theme.radii.xl,
        borderWidth: StyleSheet.hairlineWidth,
        // cardBorder, as Card uses: on Day the white card sits on a #fafafa
        // screen and the 6% subtle edge all but vanished.
        borderColor: theme.colors.cardBorder,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
    },
    input: {
        ...theme.type.body,
        color: theme.colors.textPrimary,
        paddingTop: theme.spacing.xs,
        paddingBottom: theme.spacing.sm,
        maxHeight: theme.type.body.lineHeight * 6,
    },
});

const NO_EXTRAS: ComposerExtras = {};

export const Composer = memo(function Composer(props: ComposerProps) {
    const { onSend, onStop, streaming, settings, onSettingsChange, tiers, sources = true, extras = NO_EXTRAS } = props;
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { activeSkillIds } = useActiveSkills();
    const [text, setText] = useState(props.initialText ?? '');
    const [panel, setPanel] = useState<ComposerPanel>(null);
    const picker = useAttachmentPicker(props.initialAttachments);
    const disabled = Boolean(props.disabledReason);
    const canSend = (text.trim().length > 0 || picker.attachments.length > 0) && !disabled;
    const changeContext = (next: Partial<ComposerSettings>) => onSettingsChange({ ...settings, ...next });
    const placeholder = extras.thread
        ? t('chat.composer.placeholder_thread', 'Reply to thread...')
        : (props.placeholder ?? t('chat.composer.placeholder_direct', 'Message AI...'));

    const submit = () => {
        if (streaming) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onStop();
            return;
        }
        if (!canSend) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onSend(text.trim(), picker.attachments);
        setText('');
        picker.clear();
    };

    return (
        <View style={styles.shell}>
            {props.disabledReason || extras.notice ? (
                <Text variant="caption" tone="warning" style={styles.reason}>
                    {props.disabledReason || extras.notice}
                </Text>
            ) : null}
            {extras.thread ? <ThreadBanner title={extras.thread.title} onExit={extras.thread.onExit} /> : null}
            <View style={styles.card}>
                {picker.attachments.length > 0 ? <AttachmentChips attachments={picker.attachments} onRemove={picker.remove} /> : null}
                <ContextRow
                    context={settings}
                    bases={props.knowledgeBaseNames ?? []}
                    activeSkillCount={activeSkillIds.length}
                    onChange={changeContext}
                    onOpen={() => setPanel('context')}
                    sources={sources}
                />
                <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    editable={!disabled}
                    accessibilityLabel={t('chat.composer.textarea_label', 'Chat message')}
                    underlineColorAndroid="transparent"
                    style={styles.input}
                />
                <ComposerToolbar
                    disabled={disabled}
                    streaming={streaming}
                    canSend={canSend}
                    onPlus={() => setPanel('context')}
                    onSubmit={submit}
                    onDictated={extras.dictation ? (words) => setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${words}` : words)) : undefined}
                    shield={extras.shield}
                    dial={{ tiers, value: settings.modelTier, onChange: (next) => changeContext({ modelTier: next }), memory: props.memory }}
                />
            </View>
            <ComposerPanels
                open={panel}
                onOpen={setPanel}
                context={settings}
                onChange={changeContext}
                sources={sources}
                picker={picker}
                mediaGates={extras.mediaGates}
                apps={extras.apps}
                onVoice={props.onVoice}
            />
        </View>
    );
});
