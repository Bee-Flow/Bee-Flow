/**
 * Containers: Card, Section, Divider.
 *
 * `Card` is the one place that knows how a surface is painted, which is what
 * makes the glass themes possible at all — on those, a card is a translucent
 * pane over a blur rather than a filled rectangle, and no screen should have
 * to care which.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


export interface CardProps {
    children: ReactNode;
    /** Makes the whole card a button. Adds the pressed state and a11y role. */
    onPress?: () => void;
    onLongPress?: () => void;
    padded?: boolean;
    /** Raises it off the page. Use sparingly — everything raised is nothing raised. */
    elevated?: boolean;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    /**
     * What tapping it does, when the label alone does not say. A tappable Card
     * has no affordance of its own — no chevron, no button chrome — so for a
     * screen reader the hint is the only thing that distinguishes it from a
     * decorative box.
     */
    accessibilityHint?: string;
    testID?: string;
}

export function Card({
    children,
    onPress,
    onLongPress,
    padded = true,
    elevated = false,
    style,
    accessibilityLabel,
    accessibilityHint,
    testID,
}: CardProps) {
    const theme = useTheme();

    const surface: ViewStyle = {
        borderRadius: theme.radii.lg,
        borderWidth: StyleSheet.hairlineWidth,
        // `cardBorder`: on obsidian, bgCard and bgSecondary are the same
        // value, so a hairline at 6% alpha left the card an invisible
        // rectangle. Derived rather than fixed, because that sameness is a
        // faithful port of the web app's index.css and the token must not move.
        borderColor: theme.colors.cardBorder,
        backgroundColor: theme.colors.bgCard,
        overflow: 'hidden',
        ...(padded ? { padding: theme.spacing.lg } : {}),
        ...(elevated ? theme.elevation.card : {}),
    };

    // Was a blur plus an OPAQUE absoluteFill over it, for the glass themes.
    // The blur never rendered on Android and the fill painted over the Card's
    // own press state, so a tappable card gave no feedback in two of the eight
    // themes. Both are gone with the themes that needed them.
    const inner = children;

    if (!onPress && !onLongPress) {
        return (
            <View testID={testID} style={[surface, style]}>
                {inner}
            </View>
        );
    }

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [
                surface,
                pressed ? { backgroundColor: theme.colors.bgCardHover } : null,
                style,
            ]}
        >
            {inner}
        </Pressable>
    );
}

/**
 * A titled group. `action` is the trailing affordance (usually "See all").
 * Titles are sentence case: this is a product, not a filing cabinet.
 */
export function Section({
    title,
    subtitle,
    action,
    children,
    style,
}: {
    title?: string;
    subtitle?: string;
    action?: ReactNode;
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    return (
        <View style={[{ gap: theme.spacing.md }, style]}>
            {title || action ? (
                <View style={styles.sectionHeader}>
                    <View style={styles.sectionTitles}>
                        {title ? <Text variant="heading">{title}</Text> : null}
                        {subtitle ? (
                            <Text variant="caption" tone="tertiary">
                                {subtitle}
                            </Text>
                        ) : null}
                    </View>
                    {action}
                </View>
            ) : null}
            {children}
        </View>
    );
}

export function Divider({ inset = 0 }: { inset?: number }) {
    const theme = useTheme();
    return (
        <View
            style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: theme.colors.borderSubtle,
                marginLeft: inset,
            }}
        />
    );
}

/** Vertical rhythm without every caller inventing its own margin. */
export function Spacer({ size = 'lg' }: { size?: keyof ReturnType<typeof useTheme>['spacing'] }) {
    const theme = useTheme();
    return <View style={{ height: theme.spacing[size] }} />;
}

const styles = StyleSheet.create({
    sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    sectionTitles: { flex: 1, gap: 2 },
});
