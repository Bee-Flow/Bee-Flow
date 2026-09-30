/**
 * The micro-heading over a group of navigation rows — the web sidebar's
 * SECTION_LBL (sidebarTokens.js): 11px semibold, uppercase, .05em tracking,
 * tertiary ink ("MY AGENTS", "PROJECTS", "BUILD").
 *
 * With `onPress` it is the collapsible header of that group (the web's
 * SECTION_HDR): a 44dp button with a chevron that says whether the group is
 * open. `action` is a trailing control of its own (a "+" to add one).
 */

import React, { type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon } from '../icons/Icon';
import { Text } from '../Text';

export interface SectionLabelProps {
    label: string;
    /** Makes the label the group's collapse toggle. */
    onPress?: () => void;
    /** Whether the group is open; drawn as a chevron when `onPress` is given. */
    expanded?: boolean;
    action?: ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

export function SectionLabel({ label, onPress, expanded = true, action, style, testID }: SectionLabelProps) {
    const styles = useThemedStyles(makeStyles);
    const text = (
        <Text
            variant="label"
            weight="semibold"
            style={styles.text}
            numberOfLines={1}
            accessibilityRole={onPress ? undefined : 'header'}
        >
            {label}
        </Text>
    );
    if (!onPress) {
        return (
            <View style={[styles.row, style]} testID={testID}>
                {text}
                {action}
            </View>
        );
    }
    return (
        <View style={[styles.row, style]} testID={testID}>
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ expanded }}
                style={styles.toggle}
            >
                {text}
                <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={14} color={styles.text.color} />
            </Pressable>
            {action}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 36,
        paddingHorizontal: theme.spacing[3],
    } satisfies ViewStyle,
    toggle: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1],
        minHeight: 44,
    } satisfies ViewStyle,
    text: {
        color: theme.colors.textTertiary,
        // Uppercase by style, not by string: a screen reader reads the word,
        // not a row of capitals it may spell out. .05em of 11px.
        textTransform: 'uppercase',
        letterSpacing: 0.55,
    } satisfies TextStyle,
});
