/**
 * The header of every Studio object — the web's StudioSectionHeader
 * (shared/StudioSectionHeader.jsx) for a phone. A user who learns where back,
 * the name, the status and the main action sit on one object finds them in
 * the same place on every other.
 *
 * Row one, left to right: the back arrow, the 28dp kind tile (colour and shape
 * from kinds.ts), the name at 16/600 (with an optional subline), the status chip, then the one primary
 * action and any extras (an overflow button that opens an ActionMenu). Row
 * two, when the object has sections: the scrollable TabBar, whose tabs fold
 * the web's segment strip — a phone never has the width for it inline.
 *
 * The primary action must use the accent recipe: pass a `<Button size="sm">`
 * (primary is already the accent) or a pill; never an ink fill (the web
 * rejected those, see StudioSectionHeader's "Primary actions").
 */

import { useRouter } from 'expo-router';
import React, { type ReactNode } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { IconButton } from './IconButton';
import { Icon, type IconName } from './icons/Icon';
import type { KindInput } from './kinds';
import { KindTile } from './KindTile';
import { TabBar, type TabBarItem } from './TabBar';
import { Text } from './Text';

export interface ObjectHeaderProps<T extends string = string> {
    /** A kind key or alias ('kb', 'table', …); the tile's colour, shape and glyph follow it. */
    kind: KindInput;
    /** Overrides the tile's glyph (a stored Lucide name). */
    icon?: IconName | string | null;
    /** The object's name. Empty reads "Untitled". */
    title: string;
    /** A string is drawn as the web's 11px outline chip; an element (a Badge) as given. */
    status?: ReactNode;
    /**
     * One short line under the name ("Draft · Saved"): state that would
     * otherwise need a chip or a row of its own. `subtitleTone: 'error'` for
     * a state that needs attention.
     */
    subtitle?: string;
    subtitleTone?: 'tertiary' | 'error';
    /** The kind tile before the name. Off where the screen is always the same kind and the name needs the room. */
    tile?: boolean;
    /** The ONE primary action. */
    primary?: ReactNode;
    /** Anything after the primary — usually an overflow IconButton. */
    extras?: ReactNode;
    /** Defaults to router.back(). */
    onBack?: () => void;
    /** Hides the arrow on a screen that is not pushed. */
    showBack?: boolean;
    /** The arrow's name. Say WHERE back goes ("Back to Knowledge"). */
    backLabel?: string;
    /** Makes the name a button (rename, details); say what it does in `titleHint`. */
    onTitlePress?: () => void;
    titleHint?: string;
    /** The object's sections, as a TabBar under the row. */
    tabs?: readonly TabBarItem<T>[];
    activeTab?: T;
    onTab?: (id: T) => void;
    testID?: string;
}

export function ObjectHeader<T extends string = string>({
    kind,
    icon,
    title,
    status,
    subtitle,
    subtitleTone = 'tertiary',
    tile = true,
    primary,
    extras,
    onBack,
    showBack = true,
    backLabel,
    onTitlePress,
    titleHint,
    tabs,
    activeTab,
    onTab,
    testID,
}: ObjectHeaderProps<T>) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const shown = title.trim() || t('studio.header.untitled', 'Untitled');

    return (
        <View style={styles.block} testID={testID}>
            <View style={[styles.row, showBack ? styles.rowBack : null]}>
                {showBack ? <BackButton label={backLabel} onBack={onBack} colour={styles.backGlyph.color} /> : null}
                {tile ? <KindTile kind={kind} icon={icon} size={28} /> : null}
                <Title
                    shown={shown}
                    subtitle={subtitle}
                    subtitleTone={subtitleTone}
                    onPress={onTitlePress}
                    hint={titleHint}
                    styles={styles}
                />
                <Status status={status} styles={styles} />
                {primary || extras ? (
                    <View style={styles.actions}>
                        {primary}
                        {extras}
                    </View>
                ) : null}
            </View>
            {tabs?.length && activeTab !== undefined && onTab ? (
                <TabBar items={tabs} value={activeTab} onChange={onTab} accessibilityLabel={t('studio.header.tabs', 'Sections')} />
            ) : null}
        </View>
    );
}

type Styles = ReturnType<typeof makeStyles>;

/** The arrow. Its label should say WHERE back goes. */
function BackButton({ label, onBack, colour }: { label?: string; onBack?: () => void; colour: string }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <IconButton
            icon={<Icon name="ArrowLeft" size={20} color={colour} />}
            accessibilityLabel={label ?? t('studio.header.back', 'Back')}
            onPress={onBack ?? (() => router.back())}
        />
    );
}

interface TitleProps {
    shown: string;
    subtitle?: string;
    subtitleTone: 'tertiary' | 'error';
    onPress?: () => void;
    hint?: string;
    styles: Styles;
}

/** The name, 16/600, and its subline: a heading, or a button when it does something. */
function Title({ shown, subtitle, subtitleTone, onPress, hint, styles }: TitleProps) {
    const name = (
        <>
            <Text
                variant="subheading"
                style={styles.name}
                numberOfLines={1}
                accessibilityRole={onPress ? undefined : 'header'}
            >
                {shown}
            </Text>
            {subtitle ? (
                <Text variant="caption" tone={subtitleTone} numberOfLines={1}>
                    {subtitle}
                </Text>
            ) : null}
        </>
    );
    if (!onPress) return <View style={styles.title}>{name}</View>;
    return (
        <Pressable
            style={styles.title}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={subtitle ? `${shown}, ${subtitle}` : shown}
            accessibilityHint={hint}
        >
            {name}
        </Pressable>
    );
}

/** A string is the web's outline chip ("Saved · v3"); an element (a Badge) is drawn as given. */
function Status({ status, styles }: { status: ReactNode; styles: Styles }) {
    // Centred in the row whatever the element's own alignSelf (a Badge pins
    // itself to flex-start, which floated it to the top of the header).
    if (typeof status !== 'string') return status ? <View style={styles.statusSlot}>{status}</View> : null;
    if (!status) return null;
    return (
        <View style={styles.chip}>
            <Text variant="label" tone="tertiary" numberOfLines={1}>
                {status}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    block: {
        backgroundColor: theme.colors.bgSecondary,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2.5],
        minHeight: 56,
        paddingLeft: theme.spacing[3],
        paddingRight: theme.spacing[2],
        paddingVertical: theme.spacing[1],
    } satisfies ViewStyle,
    // The arrow is a 48dp IconButton with its own padding.
    rowBack: { paddingLeft: theme.spacing[1], gap: theme.spacing[2] } satisfies ViewStyle,
    backGlyph: { color: theme.colors.textSecondary },
    title: { flexShrink: 1, flexGrow: 1, minWidth: 0 } satisfies ViewStyle,
    name: { fontSize: 16, lineHeight: 22 } satisfies TextStyle,
    // "Saved · v3": 11px tertiary on a default hairline, full radius.
    chip: {
        flexShrink: 0,
        paddingHorizontal: theme.spacing[2],
        paddingVertical: 3,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    statusSlot: { alignSelf: 'center', flexShrink: 0 } satisfies ViewStyle,
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], flexShrink: 0 } satisfies ViewStyle,
});
