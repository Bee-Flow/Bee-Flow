/**
 * What was said, in writing.
 *
 * A spoken answer is gone the moment it finishes, and half of what people ask
 * a voice assistant is a number, a name or a time — the things you most need to
 * check afterwards. So every turn is also written down, and the partials are
 * shown as they land: the transcript the moment STT returns it (which is also
 * the first evidence the phone heard the right words), then the reply as it
 * streams, before a single syllable has been spoken.
 *
 * Memoised, and deliberately so: the mic level updates the screen ten times a
 * second while listening, and re-rendering the whole conversation on each of
 * those is the difference between a smooth meter and a stuttering one.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { humanise } from '@/shared/lib/display';
import { Icon, Text, type IconName } from '@/shared/ui';

import type { LiveTurn, VoiceMessage, VoiceToolActivity } from '../model/types';

export const VoiceTranscript = React.memo(function VoiceTranscript({
    messages,
    live,
}: {
    messages: VoiceMessage[];
    live: LiveTurn;
}) {
    const theme = useTheme();

    return (
        <View style={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}>
            {messages.map((message) => (
                <Turn
                    key={message.id}
                    role={message.role}
                    text={message.content}
                    tools={message.tools}
                />
            ))}

            {live.transcript ? <Turn role="user" text={live.transcript} /> : null}
            {live.reply || live.tools.length ? (
                <Turn role="assistant" text={live.reply} tools={live.tools} pending />
            ) : null}
        </View>
    );
});

function Turn({
    role,
    text,
    tools,
    pending = false,
}: {
    role: 'user' | 'assistant';
    text: string;
    tools?: VoiceToolActivity[];
    pending?: boolean;
}) {
    const theme = useTheme();
    const mine = role === 'user';

    return (
        <View
            style={{
                alignSelf: mine ? 'flex-end' : 'flex-start',
                maxWidth: '88%',
                gap: theme.spacing.sm,
            }}
        >
            <View
                accessibilityRole="text"
                accessibilityLabel={`${mine ? 'You said' : 'Bee Flow said'}: ${text}`}
                style={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radii.lg,
                    backgroundColor: mine ? theme.colors.userBubbleBg : theme.colors.bgCard,
                    borderWidth: mine ? 0 : 1,
                    borderColor: theme.colors.borderSubtle,
                    opacity: pending && !text ? 0.6 : 1,
                }}
            >
                {text ? (
                    <Text
                        variant="body"
                        style={mine ? { color: theme.colors.userBubbleFg } : undefined}
                    >
                        {text}
                    </Text>
                ) : (
                    <Text variant="body" tone="tertiary">
                        …
                    </Text>
                )}
            </View>

            {tools?.length ? (
                <View style={{ gap: theme.spacing.xs }}>
                    {tools.map((tool) => (
                        <ToolChip key={tool.id} tool={tool} />
                    ))}
                </View>
            ) : null}
        </View>
    );
}

/**
 * A tool the assistant used. Worth showing even in voice mode: "I have moved
 * your two o'clock" is a claim, and the chip is the receipt. The summary comes
 * from the server already truncated to 100 characters.
 */
function ToolChip({ tool }: { tool: VoiceToolActivity }) {
    const theme = useTheme();
    const colour =
        tool.status === 'error'
            ? theme.colors.error
            : tool.status === 'done'
              ? theme.colors.success
              : theme.colors.textMuted;
    const icon: IconName =
        tool.status === 'error' ? 'CircleAlert' : tool.status === 'done' ? 'Check' : 'Loader';

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.sm,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radii.pill,
                backgroundColor: theme.colors.bgSecondary,
            }}
        >
            <Icon name={icon} size={13} color={colour} />
            <Text variant="label" tone="tertiary" numberOfLines={1} style={{ flexShrink: 1 }}>
                {/* `search_calendar_events` reads as noise; "Search calendar events" does not. */}
                {tool.name ? humanise(tool.name) : ''}
                {tool.summary ? ` · ${tool.summary}` : ''}
            </Text>
        </View>
    );
}
