/**
 * The composer.
 *
 * This is the most-touched control in the app, so it takes the most care:
 *
 *   - The input grows from one line to six and then scrolls. A fixed-height
 *     box makes people write shorter prompts than they meant to.
 *   - Send and Stop are the SAME button in the same place. A separate stop
 *     control means hunting for it while tokens stream past.
 *   - Above the input is a CONTEXT ROW showing only what the assistant will
 *     read — attached knowledge bases, active skills, web search — each chip
 *     tappable to remove, and nothing at all when nothing is on. It replaced an
 *     options row of up to fifteen chips (eight model tiers, six reasoning
 *     efforts, web search) hidden behind an unlabelled slider glyph, which
 *     asked a person to choose a thinking depth BEFORE the question — the one
 *     moment nobody can answer that. Depth now lives in the ＋ sheet, and only
 *     for users the server actually offers a choice to.
 *   - Attachments are staged as chips above the input and can be removed
 *     before sending. Uploading on pick and discovering the wrong file after
 *     the answer is worse than a moment's delay.
 */

import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { MAX_FILE_BYTES } from './attachments';
import { ContextRow, ContextSheet, type ChatContext } from './ContextSheet';
import { TierDial } from './TierDial';
import { type TierMap } from './tiers';
import { type Attachment, type ReasoningEffort } from './types';
import { formatBytes } from '../../lib/bytes';
import { useTheme } from '../../theme/ThemeProvider';
import { Chip } from '../../ui/Badge';
import { IconButton } from '../../ui/Button';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';
import { useActiveSkills } from '../skills/active';


export interface ComposerSettings extends ChatContext {
    /**
     * Per-question, never remembered: a stored "high" would quietly spend a
     * user's allowance on every trivial question they asked afterwards. Set
     * only by the re-ask actions under a finished answer.
     */
    reasoningEffort: ReasoningEffort | null;
}

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
     * notebook IS its source, so offering an attachment there would be
     * offering something the runtime never reads. Web search and the depth
     * control stay available either way.
     */
    sources?: boolean;
    /** Opens the voice screen. Absent on surfaces that have no voice mode. */
    onVoice?: () => void;
    /**
     * The memory switch, shown inside the tier dial's panel as it is on the
     * web. Only direct chat passes it — the surfaces that do not write memory
     * simply get no brain icon.
     */
    memory?: { enabled: boolean; onToggle: () => void };
    /** Disables everything and explains why — read-only or over quota. */
    disabledReason?: string | null;
    placeholder?: string;
    /** Seeded from a share intent or a "continue this" action. */
    initialText?: string;
    /**
     * Files handed over by Android's share sheet, staged as if the user had
     * picked them. Read once on mount — a later change does not re-stage,
     * because the user may already have removed one deliberately.
     */
    initialAttachments?: Attachment[];
}

export function Composer({
    onSend,
    onStop,
    streaming,
    settings,
    onSettingsChange,
    tiers,
    knowledgeBaseNames,
    sources = true,
    onVoice,
    memory,
    disabledReason,
    placeholder = 'Message Bee Flow',
    initialText = '',
    initialAttachments,
}: ComposerProps) {
    const theme = useTheme();
    const { toast } = useToast();
    const { activeSkillIds } = useActiveSkills();
    const [text, setText] = useState(initialText);
    const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments ?? []);
    const [contextOpen, setContextOpen] = useState(false);
    const inputRef = useRef<TextInput>(null);

    const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabledReason;

    const stage = useCallback(
        (next: Attachment) => {
            if (next.size && next.size > MAX_FILE_BYTES) {
                toast(`${next.name} is too large to attach`, 'error');
                return;
            }
            setAttachments((prev) => [...prev, next]);
        },
        [toast],
    );

    const pickDocument = useCallback(async () => {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
        if (result.canceled) return;
        for (const asset of result.assets) {
            stage({ name: asset.name, mimeType: asset.mimeType, size: asset.size ?? undefined, uri: asset.uri });
        }
    }, [stage]);

    const pickImage = useCallback(async () => {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            toast('Bee Flow needs permission to read the photo you pick', 'error');
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.8,
            allowsMultipleSelection: true,
        });
        if (result.canceled) return;
        for (const asset of result.assets) {
            stage({
                name: asset.fileName ?? 'photo.jpg',
                mimeType: asset.mimeType ?? 'image/jpeg',
                size: asset.fileSize,
                uri: asset.uri,
            });
        }
    }, [stage, toast]);

    const takePhoto = useCallback(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
            toast('Bee Flow needs camera permission to take a photo', 'error');
            return;
        }
        const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (asset) {
            stage({
                name: asset.fileName ?? 'photo.jpg',
                mimeType: asset.mimeType ?? 'image/jpeg',
                size: asset.fileSize,
                uri: asset.uri,
            });
        }
    }, [stage, toast]);

    const submit = () => {
        if (streaming) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onStop();
            return;
        }
        if (!canSend) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onSend(text.trim(), attachments);
        setText('');
        setAttachments([]);
    };

    return (
        <View
            style={{
                paddingHorizontal: theme.spacing.md,
                paddingTop: theme.spacing.sm,
                gap: theme.spacing.sm,
            }}
        >
            {disabledReason ? (
                <Text variant="caption" tone="warning" style={{ paddingHorizontal: theme.spacing.sm }}>
                    {disabledReason}
                </Text>
            ) : null}

            {/*
              * ONE card, the shape the web app uses.
              *
              * This was a hairline-topped band holding a pill input flanked by
              * loose icons — four controls on one line, reading as a chat bar.
              * The web's composer is a single raised card with the question on
              * its own line and its controls beneath, and that difference is
              * most of why the two screenshots looked like two products. The
              * card also gives the attachment and context chips somewhere to
              * live that is visibly PART of the message being composed.
              */}
            <View
                style={{
                    backgroundColor: theme.colors.bgCard,
                    borderRadius: theme.radii.xl,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme.colors.borderSubtle,
                    padding: theme.spacing.md,
                    gap: theme.spacing.sm,
                }}
            >
                {attachments.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            {attachments.map((a, i) => (
                                <Chip
                                    key={`${a.name}-${i}`}
                                    label={a.size ? `${a.name} · ${formatBytes(a.size)}` : a.name}
                                    onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                                    icon={<Feather name="x" size={12} color={theme.colors.textMuted} />}
                                />
                            ))}
                        </View>
                    </ScrollView>
                ) : null}

                <ContextRow
                    context={settings}
                    bases={knowledgeBaseNames ?? []}
                    activeSkillCount={activeSkillIds.length}
                    onChange={(next) => onSettingsChange({ ...settings, ...next })}
                    onOpen={() => setContextOpen(true)}
                    sources={sources}
                />

                <TextInput
                    ref={inputRef}
                    value={text}
                    onChangeText={setText}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    editable={!disabledReason}
                    accessibilityLabel="Message"
                    underlineColorAndroid="transparent"
                    style={[
                        theme.type.body,
                        {
                            color: theme.colors.textPrimary,
                            // No vertical centring and no minHeight: the input
                            // owns its own line now, so it grows downward from
                            // the top of the card like the web's does.
                            paddingTop: theme.spacing.xs,
                            paddingBottom: theme.spacing.sm,
                            maxHeight: theme.type.body.lineHeight * 6,
                        },
                    ]}
                />

                <View style={styles.row}>
                    {/*
                      * One "+", always shown. It replaces three loose icons
                      * (camera / image / file) AND it is the first trigger the
                      * context sheet has ever had: the chips that opened it
                      * only rendered once a knowledge base or a skill was
                      * already attached, so on a default account the sheet —
                      * and with it the only way to attach a knowledge base to a
                      * chat — was unreachable. The web's "+" is where a person
                      * already looks for exactly this.
                      */}
                    <IconButton
                        icon={<Feather name="plus" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel="Add a file, a knowledge base or a skill"
                        onPress={() => setContextOpen(true)}
                        disabled={Boolean(disabledReason)}
                    />

                    <View style={{ flex: 1 }} />

                    {onVoice ? (
                        <IconButton
                            icon={<Feather name="mic" size={18} color={theme.colors.textSecondary} />}
                            // Kept, deliberately, where the web has nothing.
                            // Dictation is the affordance that most justifies a
                            // native client; see the Record tab's own argument.
                            accessibilityLabel="Talk instead of typing"
                            onPress={onVoice}
                            disabled={Boolean(disabledReason)}
                        />
                    ) : null}

                    {/*
                      * The tier gauge, adjacent to send exactly as the web
                      * places it. This used to be a row of chips inside the
                      * "+" sheet — the phone inventing its own control for
                      * the one setting the owner compares side by side daily.
                      */}
                    <TierDial
                        tiers={tiers}
                        value={settings.modelTier}
                        onChange={(next) => onSettingsChange({ ...settings, modelTier: next })}
                        disabled={Boolean(disabledReason)}
                        memory={memory}
                    />

                    <Pressable
                        onPress={submit}
                        disabled={!streaming && !canSend}
                        accessibilityRole="button"
                        accessibilityLabel={streaming ? 'Stop generating' : 'Send message'}
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radii.pill,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: streaming
                                ? theme.colors.bgTertiary
                                : canSend
                                  ? theme.colors.accentFill
                                  : theme.colors.bgTertiary,
                        }}
                    >
                        <Feather
                            name={streaming ? 'square' : 'arrow-up'}
                            size={20}
                            color={
                                streaming
                                    ? theme.colors.textPrimary
                                    : canSend
                                      ? theme.colors.accentFillFg
                                      : theme.colors.textMuted
                            }
                        />
                    </Pressable>
                </View>
            </View>

            <ContextSheet
                visible={contextOpen}
                onClose={() => setContextOpen(false)}
                context={settings}
                onChange={(next) => onSettingsChange({ ...settings, ...next })}
                sources={sources}
                onDocument={pickDocument}
                onImage={pickImage}
                onCamera={takePhoto}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    // `center`, not `flex-end`: the toolbar is its own line under the input
    // rather than a row the input sits inside.
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
