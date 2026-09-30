/**
 * The status chip: the web's `badge` recipe from statusTokens.ts — the tone's
 * raw colour at 15% under its ink, in a full pill. Not tappable; a selectable
 * mark is a Chip.
 *
 * It used to be a hairline outline in the RAW tone, which is the one colour
 * the web never uses for words: on the light themes raw #059669 on white
 * measures 3.8:1. Tints and inks come from tones.ts, the port of the web's
 * statusTone pairs, so a chip, a row stripe and a banner cannot disagree
 * about which green is text and which is a fill.
 */

import React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon, type IconName } from './icons/Icon';
import { Text } from './Text';
import { chipColors, TONES, type Tone } from './tones';

/**
 * `ai` is the builder's step-family blue (`--type-ai` on the web), not the
 * org's brandable accent — a running run has to look the same in every
 * organisation, and `accent` is grey by default. `pinned` is the web's
 * `--pinned` cyan for frozen or hand-edited data.
 */
export type BadgeTone = Tone;

export function Badge({
    label,
    tone = 'neutral',
    icon,
    style,
    testID,
}: {
    label: string;
    tone?: BadgeTone;
    /** A glyph before the word, in the same ink (the web's status icon). */
    icon?: IconName;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View testID={testID} style={[styles.chip, styles.fill[tone], style]}>
            {icon ? <Icon name={icon} size={12} color={styles.ink[tone].color as string} /> : null}
            <Text variant="label" style={styles.ink[tone]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1],
        paddingHorizontal: theme.spacing[2],
        paddingVertical: 3,
        borderRadius: theme.radii.pill,
        alignSelf: 'flex-start',
    } satisfies ViewStyle,
    fill: Object.fromEntries(
        TONES.map((tone) => [tone, { backgroundColor: chipColors(theme.colors, tone).bg }]),
    ) as Record<Tone, ViewStyle>,
    ink: Object.fromEntries(
        TONES.map((tone) => [tone, { color: chipColors(theme.colors, tone).fg }]),
    ) as Record<Tone, TextStyle>,
});
