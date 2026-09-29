/**
 * One skill in the library.
 *
 * The row does two jobs at once — open the pack, and switch it on for the next
 * message — so the switch is a real control inside the row rather than the
 * row's own state. A tap anywhere else opens the detail screen; the switch
 * keeps its own touch target and its own label, because "Sales tone" and "Use
 * Sales tone in new chats" are two different things to announce.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { Switch } from '../../../ui/Controls';
import { Text } from '../../../ui/Text';
import type { Skill } from '../types';

export function SkillRow({
    skill,
    active,
    onPress,
    onToggle,
    onLongPress,
}: {
    skill: Skill;
    active: boolean;
    onPress: () => void;
    onToggle: () => void;
    onLongPress?: () => void;
}) {
    const theme = useTheme();

    // An automation-linked skill is forced dynamic by the runtime whatever the
    // flag says (core/tools/skillInjection.js), so the badge follows the
    // runtime's rule rather than the column.
    const dynamic = skill.dynamicActivation || Boolean(skill.automationId);

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={skill.name}
            accessibilityHint={skill.description || 'Open this skill'}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: 72,
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
            })}
        >
            <View
                style={{
                    width: 40,
                    height: 40,
                    borderRadius: theme.radii.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active ? theme.colors.itemActiveBg : theme.colors.bgTertiary,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: active ? theme.colors.accentPrimary : 'transparent',
                }}
            >
                <Text variant="heading" accessibilityElementsHidden>
                    {skill.icon}
                </Text>
            </View>

            <View style={{ flex: 1, gap: 4 }}>
                <Text variant="subheading" numberOfLines={1}>
                    {skill.name}
                </Text>
                {skill.description ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={2}>
                        {skill.description}
                    </Text>
                ) : null}
                {skill.isShared || dynamic ? (
                    <View style={{ flexDirection: 'row', gap: theme.spacing.xs, flexWrap: 'wrap' }}>
                        {skill.isShared ? (
                            <Badge
                                label={skill.sharedGroups.length > 0 ? 'Shared with groups' : 'Shared'}
                            />
                        ) : null}
                        {dynamic ? <Badge label="When relevant" tone="accent" /> : null}
                    </View>
                ) : null}
            </View>

            <Switch
                value={active}
                onValueChange={onToggle}
                accessibilityLabel={`Use ${skill.name} in new chats`}
            />
        </Pressable>
    );
}
