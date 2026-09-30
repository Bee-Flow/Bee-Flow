/**
 * Live progress for a swarm turn.
 *
 * A `swarm` tier turn short-circuits into a completely different server runtime
 * that emits none of the ordinary chat events — no `content` at all until the
 * synthesis lands. Without this panel the screen shows an empty bubble and a
 * spinner for however long a fan-out takes, which reads as a hang.
 *
 * Workers are collapsed to one line each. Their output is working-out, not the
 * answer; the answer is the synthesis that arrives on `swarm_completed` and
 * renders as the message body like any other reply.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import type { SwarmProgress } from '@/features/chat/model/types';
import { Icon, Text } from '@/shared/ui';


export function SwarmPanel({ progress }: { progress: SwarmProgress }) {
    const theme = useTheme();
    const [expanded, setExpanded] = useState<string | null>(null);

    const running = progress.workers.filter((w) => w.status === 'running').length;
    const done = progress.workers.length - running;

    return (
        <View
            accessibilityLiveRegion="polite"
            style={{
                marginHorizontal: theme.spacing.lg,
                marginBottom: theme.spacing.sm,
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.borderSubtle,
                backgroundColor: theme.colors.bgCard,
                gap: theme.spacing.sm,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Icon
                    name={progress.completed ? 'CircleCheckBig' : 'Users'}
                    size={14}
                    color={progress.completed ? theme.colors.success : theme.colors.accentPrimary}
                />
                <Text variant="label" tone="tertiary" style={{ flex: 1 }}>
                    {progress.completed
                        ? `SWARM COMPLETE · ${progress.workers.length} AGENTS`
                        : progress.phase
                          ? `${progress.phase.toUpperCase()} · ${done}/${progress.workers.length} DONE`
                          : 'SWARM STARTING'}
                </Text>
            </View>

            {progress.workers.map((worker) => {
                const open = expanded === worker.id;
                return (
                    <View key={worker.id}>
                        <Pressable
                            onPress={() => setExpanded(open ? null : worker.id)}
                            disabled={!worker.text}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: open }}
                            accessibilityLabel={`${worker.name}, ${worker.status}`}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.sm,
                                minHeight: 28,
                            }}
                        >
                            <Icon
                                name={worker.status === 'done' ? 'Check' : 'Loader'}
                                size={12}
                                color={
                                    worker.status === 'done'
                                        ? theme.colors.success
                                        : theme.colors.textMuted
                                }
                            />
                            <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                                {worker.name}
                            </Text>
                            {worker.text ? (
                                <Icon
                                    name={open ? 'ChevronUp' : 'ChevronDown'}
                                    size={12}
                                    color={theme.colors.textMuted}
                                />
                            ) : null}
                        </Pressable>
                        {open && worker.text ? (
                            <View
                                style={{
                                    borderLeftWidth: 2,
                                    borderLeftColor: theme.colors.borderSubtle,
                                    paddingLeft: theme.spacing.md,
                                    marginLeft: 6,
                                    marginTop: theme.spacing.xs,
                                }}
                            >
                                <Text variant="label" tone="tertiary" selectable>
                                    {worker.text}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}
