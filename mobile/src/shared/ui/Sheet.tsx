/**
 * The bottom sheet.
 *
 * This was written four times — once each in the automate, library, recording
 * and settings feature folders — because the shared kit had no modal primitive
 * and no author wanted to reach into another feature's directory for one. All
 * four said in their own header comment that this file should exist. It now
 * does, and the four copies are gone.
 *
 * They had drifted, and not only cosmetically. Collapsing them settles four
 * arguments the user was otherwise having with the app:
 *
 *   - Keyboard. Three of the four wrapped the dock in a KeyboardAvoidingView
 *     with `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`, which on
 *     Android is no behaviour at all — and Android is the only platform this
 *     app ships to. Nothing else lifts the sheet: the manifest's `adjustPan`
 *     is the activity's, and the <Modal> is a dialog window of its own, which
 *     React Native gives `adjustResize` but also draws edge to edge — and a
 *     window that draws edge to edge is not resized for the keyboard (from
 *     Android 11 on the app is handed the keyboard as an inset instead). So
 *     the view has to do it, and with `padding`, not `height`:
 *
 *       `height` shrinks the view by the keyboard's overlap, which lifts the
 *       bottom edge of a view laid out from the top of the screen (Screen's
 *       `avoidKeyboard`). This dock is laid out from the BOTTOM
 *       (`justifyContent: 'flex-end'`), so shrinking it moves its top edge
 *       down instead, while its bottom edge stays behind the keyboard. Worse,
 *       `height` counts the overlap it already took off on top of the overlap
 *       it measures after the relayout (it expects that bottom edge to have
 *       risen), so each layout pass takes the keyboard off again until the
 *       dock is gone: with a field focused, the whole sheet ends up under
 *       the keyboard.
 *       `padding` puts the overlap under the panel instead, so the panel ends
 *       where the keyboard starts, and a relayout measures the same overlap
 *       again. Where the window does resize, there is no overlap and it adds
 *       nothing.
 *   - Backdrop. 0.45 alpha in three copies, 0.5 in the fourth (and on the
 *     web, whose bottom modal this now follows: 16 radius, header divider).
 *   - Border. `borderDefault` in three, `borderSubtle` in the fourth, so the
 *     sheet's top edge changed weight between tabs.
 *   - Heading. Only two marked the title `accessibilityRole="header"`, so
 *     TalkBack's heading navigation worked in half the sheets.
 *
 * `tall` came from the Library, which is the only feature with sheets holding
 * a full-height list; it is kept because a form sheet and a list sheet really
 * do want different heights, and it is opt-in.
 *
 * Still a plain RN <Modal> rather than a gesture-driven sheet, which is the one
 * decision all four copies agreed on: every sheet in this app holds a form or a
 * scrolling list, and a drag-to-dismiss handle fights the scroll view for the
 * same vertical gesture. A close button never has that argument.
 */

import React, { type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { IconButton } from './IconButton';
import { Icon } from './icons/Icon';
import { Text } from './Text';

export function Sheet({
    visible,
    onClose,
    title,
    subtitle,
    children,
    footer,
    /** Turn off when the body brings its own scroll container (a FlatList). */
    scroll = true,
    /** Sheets that hold a full-height list want the room; forms do not. */
    tall = false,
}: {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    children: ReactNode;
    footer?: ReactNode;
    scroll?: boolean;
    tall?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const insets = useSafeAreaInsets();

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            // Android's back button must close the sheet, not the screen under it.
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <View style={styles.root}>
                <Pressable
                    style={styles.backdrop}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close', 'Close')}
                />
                <KeyboardAvoidingView
                    // 'padding', not 'height': see the header. The backdrop
                    // stays outside this view so it keeps covering the full
                    // screen while the panel rises.
                    behavior="padding"
                    style={styles.dock}
                    testID="sheet-dock"
                >
                    <View
                        accessibilityViewIsModal
                        style={[styles.panel, tall ? styles.tall : null, { paddingBottom: insets.bottom + 12 }]}
                    >
                        <View style={styles.header}>
                            <View style={styles.titles}>
                                <Text variant="heading" accessibilityRole="header" numberOfLines={2}>
                                    {title}
                                </Text>
                                {subtitle ? (
                                    <Text variant="caption" tone="tertiary">
                                        {subtitle}
                                    </Text>
                                ) : null}
                            </View>
                            <IconButton
                                icon={<Icon name="X" size={20} color={styles.closeGlyph.color} />}
                                accessibilityLabel={t('common.close', 'Close')}
                                onPress={onClose}
                            />
                        </View>

                        {scroll ? (
                            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
                                {children}
                            </ScrollView>
                        ) : (
                            <View style={styles.bodyFixed}>{children}</View>
                        )}

                        {footer ? <View style={styles.footer}>{footer}</View> : null}
                    </View>
                </KeyboardAvoidingView>
            </View>
        </Modal>
    );
}

const makeStyles = (theme: Theme) => ({
    root: { flex: 1, justifyContent: 'flex-end' } satisfies ViewStyle,
    dock: { width: '100%' } satisfies ViewStyle,
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        // The web's modal scrim (`bg-black/50`).
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
    } satisfies ViewStyle,
    // The web's bottom modal: bgSecondary, a subtle edge, `rounded-t-2xl`
    // (16 — it was 20 here, a step rounder than the web) and its big shadow.
    panel: {
        backgroundColor: theme.colors.bgSecondary,
        borderTopLeftRadius: theme.radii.lg,
        borderTopRightRadius: theme.radii.lg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.borderDefault,
        boxShadow: theme.shadows.popover,
        maxHeight: '86%',
    } satisfies ViewStyle,
    tall: { maxHeight: '92%', minHeight: '60%' } satisfies ViewStyle,
    // The web modal's header row (`px-5 py-4 border-b`), less the right
    // gutter the close button's own padding supplies.
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingLeft: theme.spacing[5],
        paddingRight: theme.spacing.sm,
        paddingVertical: theme.spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    titles: { flex: 1, gap: 2 } satisfies ViewStyle,
    closeGlyph: { color: theme.colors.textSecondary },
    body: {
        paddingHorizontal: theme.spacing[5],
        paddingTop: theme.spacing.lg,
        paddingBottom: theme.spacing.lg,
        gap: theme.spacing.lg,
    } satisfies ViewStyle,
    bodyFixed: { flexShrink: 1 } satisfies ViewStyle,
    footer: {
        paddingHorizontal: theme.spacing[5],
        paddingTop: theme.spacing.sm,
        gap: theme.spacing.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
});
