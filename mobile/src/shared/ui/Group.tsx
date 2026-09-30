/**
 * The grouped card a settings screen is made of (its rows: InfoRow, NoteRow,
 * SettingRow, ToggleRow).
 *
 * `Card` is the kit's general surface and is the opposite shape: it is padded
 * and takes arbitrary children. A settings group is unpadded, so its rows run
 * edge to edge, and hairline-separated, so a list of six toggles reads as one
 * object rather than six floating slabs. That difference is worth a component
 * because getting it wrong is invisible on one screen and glaring across
 * fourteen — which is how many now import this.
 *
 * It was written in features/settings because settings was the only consumer
 * when src/ui was off limits. It is not any more: app/org, app/admin,
 * app/usage, app/integrations and app/support all reached across into the
 * settings feature folder for it, which is the shape of a thing that belongs
 * in the kit.
 */

import React, { Children, Fragment, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Card } from './Card';
import { Divider } from './Divider';
import { Text } from './Text';


export function Group({
    title,
    footer,
    children,
    style,
}: {
    /** Small all-caps label above the card. Omit for an unlabelled group. */
    title?: string;
    /** Explanatory copy under the card. This is where a setting's WHY lives. */
    footer?: string;
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    // Children are separated rather than each row carrying its own border, so
    // the first and last rows never draw one against the card's own edge.
    const rows = Children.toArray(children).filter(Boolean);

    return (
        <View style={[{ gap: theme.spacing.sm }, style]}>
            {title ? (
                <Text
                    variant="label"
                    tone="tertiary"
                    style={{ paddingHorizontal: theme.spacing.xs }}
                >
                    {title.toUpperCase()}
                </Text>
            ) : null}
            <Card padded={false}>
                {rows.map((row, index) => (
                    <Fragment key={index}>
                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                        {row}
                    </Fragment>
                ))}
            </Card>
            {footer ? (
                <Text
                    variant="caption"
                    tone="tertiary"
                    style={{ paddingHorizontal: theme.spacing.xs }}
                >
                    {footer}
                </Text>
            ) : null}
        </View>
    );
}
