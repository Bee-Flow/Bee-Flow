/**
 * The grouped-row shapes a settings screen is made of: Group, InfoRow, NoteRow.
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

import { Card, Divider } from './Surface';
import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


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

/**
 * A read-only fact: label on the left, value on the right.
 *
 * Not SettingRow, which is a button and renders a chevron. A version number or
 * a licence tier is not a place you can go, and giving it a chevron is a lie
 * the user only discovers by tapping.
 */
export function InfoRow({
    label,
    value,
    tone = 'tertiary',
    selectable = false,
}: {
    label: string;
    value: string;
    tone?: 'tertiary' | 'success' | 'warning' | 'error' | 'primary';
    /** Turn on for values a person will want to copy into a bug report. */
    selectable?: boolean;
}) {
    const theme = useTheme();
    return (
        <View
            accessible
            accessibilityLabel={`${label}: ${value}`}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
            }}
        >
            <Text variant="body" style={{ flex: 1 }}>
                {label}
            </Text>
            <Text
                variant="body"
                tone={tone}
                selectable={selectable}
                numberOfLines={2}
                style={{ flexShrink: 1, maxWidth: '60%', textAlign: 'right' }}
            >
                {value}
            </Text>
        </View>
    );
}

/** A row that is nothing but prose — a warning, an explanation, a caveat. */
export function NoteRow({ children }: { children: ReactNode }) {
    const theme = useTheme();
    return (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            {typeof children === 'string' ? (
                <Text variant="caption" tone="tertiary">
                    {children}
                </Text>
            ) : (
                children
            )}
        </View>
    );
}
