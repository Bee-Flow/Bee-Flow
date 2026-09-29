/**
 * One message in the transcript.
 *
 * The layout is asymmetric on purpose. The user's message is a bubble, right-
 * aligned and capped at 85% width — short, scannable, obviously theirs. The
 * assistant's answer is NOT a bubble: it runs the full width with no
 * background, because a long answer inside a rounded rectangle wastes ~15% of
 * a phone's horizontal space on decoration, and the answer is the content of
 * the screen rather than a remark in a conversation.
 *
 * Everything the model did on the way to the answer — thinking, tools,
 * citations — is collapsed by default and expandable. On a desktop those live
 * in a side panel; here they would push the answer off-screen.
 */

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { memo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { rateMessage, useMessageRating, type FeedbackRating, type FeedbackTarget } from './feedback';
import { Markdown } from './Markdown';
import type { ChatMessage, KbSource, ToolActivity } from './types';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge } from '../../ui/Badge';
import { Spinner } from '../../ui/Feedback';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';


export interface MessageBubbleProps {
    message: ChatMessage;
    /** Live text for the turn currently streaming into this message. */
    streamingText?: string;
    onRetry?: () => void;
    /**
     * Where to file a rating of this answer. Omit it and the thumbs do not
     * render — which is the right behaviour for a surface whose transcript the
     * server does not keep, since a rating there would point at nothing.
     */
    feedback?: Omit<FeedbackTarget, 'messageId'>;
}

export const MessageBubble = memo(function MessageBubble({
    message,
    streamingText,
    onRetry,
    feedback,
}: MessageBubbleProps) {
    const theme = useTheme();
    const { toast } = useToast();
    const isUser = message.role === 'user';
    const body = streamingText ?? message.content;

    const copy = () => {
        void Clipboard.setStringAsync(body);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        toast('Copied');
    };

    if (isUser) {
        return (
            <Pressable
                onLongPress={copy}
                accessibilityRole="text"
                accessibilityLabel={`You said: ${message.content}`}
                style={[styles.userRow, { paddingHorizontal: theme.spacing.lg }]}
            >
                <View
                    style={{
                        maxWidth: '85%',
                        backgroundColor: theme.colors.userBubbleBg,
                        borderRadius: theme.radii.lg,
                        // Squared off at the sending corner — the standard cue
                        // for "this one is mine".
                        borderBottomRightRadius: theme.radii.sm,
                        paddingHorizontal: theme.spacing.lg,
                        paddingVertical: theme.spacing.md,
                    }}
                >
                    <Text variant="body" style={{ color: theme.colors.userBubbleFg }} selectable>
                        {message.content}
                    </Text>
                    {message.attachments?.length ? (
                        <AttachmentStrip attachments={message.attachments} />
                    ) : null}
                </View>
            </Pressable>
        );
    }

    return (
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
            {message.thinking ? <Collapsible title="Thinking" body={message.thinking} /> : null}
            {message.tools?.length ? <ToolStrip tools={message.tools} /> : null}

            {message.error ? (
                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="body" tone="error">
                        {message.error}
                    </Text>
                    {onRetry ? (
                        <Pressable
                            onPress={onRetry}
                            accessibilityRole="button"
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                        >
                            <Feather name="refresh-cw" size={14} color={theme.colors.accentPrimary} />
                            <Text variant="caption" tone="accent">
                                Try again
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : message.streaming && !body ? (
                // The gap between "send" and the first token is where the
                // model is choosing tools and reading context, and it can run
                // to several seconds. An empty Markdown block renders as
                // nothing at all, which reads as a message that failed to
                // send. MeetingChatSheet already says this out loud; so does
                // this now.
                <View
                    accessibilityLiveRegion="polite"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
                >
                    <Spinner />
                    <Text variant="body" tone="tertiary">
                        Thinking…
                    </Text>
                </View>
            ) : (
                // `accessible={false}` on the wrapper, not the child: TalkBack
                // otherwise flattens a long answer into one unnavigable node,
                // and the long-press-to-copy target becomes the whole screen.
                <Pressable onLongPress={copy} accessible={false}>
                    <View accessibilityLiveRegion={message.streaming ? 'polite' : 'none'}>
                        <Markdown value={body} />
                    </View>
                </Pressable>
            )}

            {message.images?.length ? (
                <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
                    {message.images.map((img, i) => (
                        <Image
                            key={i}
                            source={{ uri: `data:${img.mimeType};base64,${img.data}` }}
                            style={{
                                width: '100%',
                                aspectRatio: 1,
                                borderRadius: theme.radii.md,
                                backgroundColor: theme.colors.bgTertiary,
                            }}
                            contentFit="contain"
                            accessibilityLabel="Generated image"
                        />
                    ))}
                </View>
            ) : null}

            {message.sources?.length ? <Sources sources={message.sources} /> : null}

            {message.interrupted ? (
                <Text variant="label" tone="warning" style={{ marginTop: theme.spacing.sm }}>
                    Answer stopped early
                </Text>
            ) : null}

            {!message.streaming && !message.error ? (
                // `xl` rather than `lg`: the actions below carry a widened
                // hit target, and at a 16px gap two adjacent targets would
                // overlap — on Android the wrong one then wins the tap.
                <View style={{ flexDirection: 'row', gap: theme.spacing.xl, marginTop: theme.spacing.sm }}>
                    <MessageAction icon="copy" label="Copy answer" onPress={copy} />
                    {feedback ? (
                        <Thumbs target={{ ...feedback, messageId: message.id }} />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

/**
 * Was this answer any good?
 *
 * Both thumbs stay visible after you press one — the pressed one fills in with
 * the accent colour. Hiding the other would make a mis-tap unfixable, and this
 * is the only control in the app whose whole purpose is to be pressed by
 * someone who is already annoyed.
 */
function Thumbs({ target }: { target: FeedbackTarget }) {
    const theme = useTheme();
    const { toast } = useToast();
    const current = useMessageRating(target);

    const rate = (rating: FeedbackRating) => {
        if (current === rating) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        rateMessage(target, rating).catch(() => {
            // The optimistic fill has already been rolled back by the store, so
            // the icon and the message agree. Saying nothing here would leave a
            // person believing they had reported a bad answer when they had not.
            toast('Could not send that just now');
        });
    };

    return (
        <>
            <MessageAction
                icon="thumbs-up"
                label="Good answer"
                onPress={() => rate('up')}
                color={current === 'up' ? theme.colors.accentText : undefined}
                selected={current === 'up'}
            />
            <MessageAction
                icon="thumbs-down"
                label="Bad answer"
                onPress={() => rate('down')}
                color={current === 'down' ? theme.colors.accentText : undefined}
                selected={current === 'down'}
            />
        </>
    );
}

function MessageAction({
    icon,
    label,
    onPress,
    color,
    selected,
}: {
    icon: keyof typeof Feather.glyphMap;
    label: string;
    onPress: () => void;
    color?: string;
    /** Renders as a toggle to a screen reader rather than a plain button. */
    selected?: boolean;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            // A 15px glyph with the standard 8px slop is a 31px target — well
            // under the 48px this app holds itself to everywhere else. The
            // vertical axis is free (nothing sits above or below the row), so
            // it takes most of the growth; horizontally each target stops
            // short of half the 24px gap so two never overlap.
            hitSlop={{ top: 16, bottom: 16, left: 11, right: 11 }}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={selected === undefined ? undefined : { selected }}
        >
            <Feather name={icon} size={15} color={color ?? theme.colors.textMuted} />
        </Pressable>
    );
}

/** Collapsed-by-default detail — reasoning traces and long tool output. */
function Collapsible({ title, body }: { title: string; body: string }) {
    const theme = useTheme();
    const [open, setOpen] = useState(false);
    return (
        <View style={{ marginBottom: theme.spacing.sm }}>
            <Pressable
                onPress={() => setOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={title}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}
            >
                <Feather
                    name={open ? 'chevron-down' : 'chevron-right'}
                    size={14}
                    color={theme.colors.textMuted}
                />
                <Text variant="label" tone="tertiary">
                    {title.toUpperCase()}
                </Text>
            </Pressable>
            {open ? (
                <View
                    style={{
                        borderLeftWidth: 2,
                        borderLeftColor: theme.colors.borderSubtle,
                        paddingLeft: theme.spacing.md,
                        marginTop: theme.spacing.xs,
                    }}
                >
                    <Text variant="caption" tone="tertiary" selectable>
                        {body}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

function ToolStrip({ tools }: { tools: ToolActivity[] }) {
    const theme = useTheme();
    return (
        <View style={{ gap: theme.spacing.xs, marginBottom: theme.spacing.sm }}>
            {tools.map((tool) => (
                <View key={tool.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Feather
                        name={tool.status === 'error' ? 'x-circle' : tool.status === 'done' ? 'check' : 'loader'}
                        size={12}
                        color={
                            tool.status === 'error'
                                ? theme.colors.error
                                : tool.status === 'done'
                                  ? theme.colors.success
                                  : theme.colors.textMuted
                        }
                    />
                    <Text variant="label" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                        {tool.detail || tool.name}
                    </Text>
                </View>
            ))}
        </View>
    );
}

/**
 * Citations, horizontally scrollable.
 *
 * A vertical list of eight sources under every answer would double the length
 * of the transcript. A horizontal strip keeps them one swipe away and out of
 * the reading path.
 */
function Sources({ sources }: { sources: KbSource[] }) {
    const theme = useTheme();
    return (
        <View style={{ marginTop: theme.spacing.md }}>
            <Text variant="label" tone="tertiary" style={{ marginBottom: theme.spacing.xs }}>
                SOURCES
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    {sources.map((source, i) => (
                        <View
                            key={source.id ?? i}
                            style={{
                                width: 200,
                                padding: theme.spacing.md,
                                borderRadius: theme.radii.md,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: theme.colors.borderSubtle,
                                backgroundColor: theme.colors.bgCard,
                                gap: 4,
                            }}
                        >
                            <Text variant="caption" weight="semibold" numberOfLines={2}>
                                {source.title || source.url || `Source ${i + 1}`}
                            </Text>
                            {source.snippet ? (
                                <Text variant="label" tone="tertiary" numberOfLines={3}>
                                    {source.snippet}
                                </Text>
                            ) : null}
                        </View>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}

function AttachmentStrip({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: theme.spacing.sm }}>
            {attachments.map((a, i) => (
                <Badge key={a.id ?? i} label={a.name} tone="neutral" />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    userRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 6 },
});
