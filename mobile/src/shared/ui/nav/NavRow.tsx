/**
 * A navigation row — the web sidebar's row (shell/sidebar/NavRow.jsx and
 * sidebarTokens.js) at a phone's touch height. Idle: secondary words and a
 * tertiary glyph. Active: the active-item tint, a 3px accent bar on the
 * leading edge, the glyph in the accent at the heavier stroke, and the words
 * in primary ink at semibold.
 *
 * 44dp instead of the web's 36, radius 8, 13px words. A count sits on the
 * right in one of the web's two treatments: `badge` (NavRow.jsx's accent-
 * tinted pill, for what waits on you — Cowork, Approvals) or `plain` (the
 * Studio flyout's tertiary number, for how many there are, 0 included).
 * `expanded` turns the row into a group header with a chevron (the Studio
 * group); `locked` is a gated destination shown but not offered (see lockHint
 * in core/access). `description` is FlyoutRow's muted line under the label —
 * a form that is not live, why a row is locked — drawn, not only announced.
 */

import React, { type ReactNode } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { ACTIVE_STROKE, Icon, type IconName } from '../icons/Icon';
import { Text } from '../Text';
import { tint } from '../tint';

export interface NavRowProps {
    label: string;
    icon?: IconName;
    /** Drawn in place of `icon`: a stored icon (AppIcon), a project's tile. */
    leading?: ReactNode;
    /** Paints the glyph in its own colour (a published app's accent) when idle. */
    iconColor?: string;
    active?: boolean;
    onPress: () => void;
    /** A number beside the label; see `countStyle`. Nullish renders nothing. */
    count?: number | null;
    /**
     * `badge` (default): what waits on you, the accent pill; 0 renders nothing.
     * `plain`: how many there are, tertiary figures; any known count, 0 too.
     */
    countStyle?: 'badge' | 'plain';
    /** A muted line under the label, two lines at most. */
    description?: string;
    /** Set for a group header: draws the chevron and announces the state. */
    expanded?: boolean;
    /** A sub-row under a group header. */
    inset?: boolean;
    /** Shown, not offered: dimmed, with a lock. Say why in `accessibilityHint`. */
    locked?: boolean;
    trailing?: ReactNode;
    accessibilityHint?: string;
    testID?: string;
}

/** The count a row shows, or null: an unknown or zero count is noise on a nav row. */
export function navCount(count: number | null | undefined, max = 99): string | null {
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    const n = Math.floor(count);
    if (n <= 0) return null;
    return n > max ? `${max}+` : String(n);
}

/** A `plain` count: any known number, 0 included (FlyoutRow's `hasCount`). */
export function plainCount(count: number | null | undefined): string | null {
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    return String(Math.max(0, Math.floor(count)));
}

export function NavRow({
    label,
    icon,
    leading,
    iconColor,
    active = false,
    onPress,
    count,
    countStyle = 'badge',
    description,
    expanded,
    inset = false,
    locked = false,
    trailing,
    accessibilityHint,
    testID,
}: NavRowProps) {
    const styles = useThemedStyles(makeStyles);
    const shown = countStyle === 'plain' ? plainCount(count) : navCount(count);
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole={expanded === undefined ? 'link' : 'button'}
            accessibilityLabel={shown ? `${label}, ${shown}` : label}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ selected: active, expanded, disabled: locked }}
            style={({ pressed }) => [
                styles.row,
                inset ? styles.inset : null,
                active ? styles.active : pressed ? styles.pressed : null,
                locked ? styles.locked : null,
            ]}
        >
            {active ? <View style={styles.bar} /> : null}
            {leading ?? <Glyph icon={icon} iconColor={iconColor} active={active} styles={styles} />}
            <RowLabel label={label} description={description} active={active} styles={styles} />
            <Marks
                shown={shown}
                plain={countStyle === 'plain'}
                trailing={trailing}
                locked={locked}
                expanded={expanded}
                styles={styles}
            />
        </Pressable>
    );
}

type Styles = ReturnType<typeof makeStyles>;

/** The row's glyph: the accent at the heavier stroke when current, else its own colour or tertiary. */
function Glyph({ icon, iconColor, active, styles }: { icon?: IconName; iconColor?: string; active: boolean; styles: Styles }) {
    if (!icon) return null;
    const color = active ? styles.accent.color : (iconColor ?? styles.idleGlyph.color);
    return <Icon name={icon} size={18} color={color} strokeWidth={active ? ACTIVE_STROKE : undefined} />;
}

/** The label, and the muted line under it. */
function RowLabel({ label, description, active, styles }: { label: string; description?: string; active: boolean; styles: Styles }) {
    return (
        <View style={styles.labelBox}>
            <Text
                variant="caption"
                weight={active ? 'semibold' : 'regular'}
                style={active ? styles.activeText : styles.idleText}
                numberOfLines={1}
            >
                {label}
            </Text>
            {description ? (
                <Text variant="label" tone="tertiary" numberOfLines={2} style={styles.description}>
                    {description}
                </Text>
            ) : null}
        </View>
    );
}

/** What sits after the label: the count, the caller's own mark, the lock, the chevron. */
function Marks({
    shown,
    plain,
    trailing,
    locked,
    expanded,
    styles,
}: {
    shown: string | null;
    plain: boolean;
    trailing?: ReactNode;
    locked: boolean;
    expanded?: boolean;
    styles: Styles;
}) {
    return (
        <>
            {shown && plain && !locked ? (
                <Text variant="label" style={styles.plainCount}>
                    {shown}
                </Text>
            ) : null}
            {shown && !plain ? (
                <View style={styles.count}>
                    <Text variant="label" weight="bold" style={styles.countText}>
                        {shown}
                    </Text>
                </View>
            ) : null}
            {trailing}
            {locked ? <Icon name="Lock" size={14} color={styles.idleGlyph.color} /> : null}
            {expanded !== undefined ? (
                <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={16} color={styles.idleGlyph.color} />
            ) : null}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2.5],
        minHeight: 44,
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[1.5],
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    inset: { paddingLeft: theme.spacing[8] } satisfies ViewStyle,
    active: { backgroundColor: theme.colors.itemActiveBg } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    locked: { opacity: 0.6 } satisfies ViewStyle,
    bar: {
        position: 'absolute',
        left: 0,
        top: 10,
        bottom: 10,
        width: 3,
        borderTopRightRadius: 3,
        borderBottomRightRadius: 3,
        backgroundColor: theme.colors.accentPrimary,
    } satisfies ViewStyle,
    accent: { color: theme.colors.accentText },
    idleGlyph: { color: theme.colors.textTertiary },
    labelBox: { flex: 1, minWidth: 0 } satisfies ViewStyle,
    description: { marginTop: 2 } satisfies TextStyle,
    activeText: { color: theme.colors.textPrimary } satisfies TextStyle,
    idleText: { color: theme.colors.textSecondary } satisfies TextStyle,
    count: {
        paddingHorizontal: theme.spacing[1.5],
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: tint(theme.colors.accentPrimary, 12),
    } satisfies ViewStyle,
    countText: { color: theme.colors.accentText, fontVariant: ['tabular-nums'] } satisfies TextStyle,
    // FlyoutRow's count: 12px tertiary figures, no fill (11 is the phone's floor step).
    plainCount: { color: theme.colors.textTertiary, fontVariant: ['tabular-nums'] } satisfies TextStyle,
});
