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
 *     app ships to. The manifest sets `windowSoftInputMode="adjustPan"`, so a
 *     translucent modal does not resize either: typing into a sheet's text
 *     field pushed it under the keyboard on three tabs out of four. Settings
 *     had it right with `behavior="height"`, and that is what is kept.
 *   - Backdrop. 0.45 alpha in three copies, 0.5 in the fourth.
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

import { Feather } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from './Button';
import { Text } from './Text';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';

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
    const theme = useTheme();
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
                    // 'height' on Android, not undefined: see the header. The
                    // backdrop stays outside this view so it keeps covering the
                    // full screen while the dock shrinks.
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.dock}
                >
                    <View
                        accessibilityViewIsModal
                        style={{
                            backgroundColor: theme.colors.bgSecondary,
                            borderTopLeftRadius: theme.radii.xl,
                            borderTopRightRadius: theme.radii.xl,
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderColor: theme.colors.borderDefault,
                            paddingBottom: insets.bottom + theme.spacing.md,
                            maxHeight: tall ? '92%' : '86%',
                            ...(tall ? { minHeight: '60%' } : {}),
                        }}
                    >
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'flex-start',
                                gap: theme.spacing.sm,
                                paddingLeft: theme.spacing.lg,
                                paddingRight: theme.spacing.sm,
                                paddingTop: theme.spacing.lg,
                                paddingBottom: theme.spacing.sm,
                            }}
                        >
                            <View style={{ flex: 1, gap: 2 }}>
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
                                icon={
                                    <Feather name="x" size={20} color={theme.colors.textSecondary} />
                                }
                                accessibilityLabel={t('common.close', 'Close')}
                                onPress={onClose}
                            />
                        </View>

                        {scroll ? (
                            <ScrollView
                                keyboardShouldPersistTaps="handled"
                                contentContainerStyle={{
                                    paddingHorizontal: theme.spacing.lg,
                                    paddingBottom: theme.spacing.lg,
                                    gap: theme.spacing.lg,
                                }}
                            >
                                {children}
                            </ScrollView>
                        ) : (
                            <View style={{ flexShrink: 1 }}>{children}</View>
                        )}

                        {footer ? (
                            <View
                                style={{
                                    paddingHorizontal: theme.spacing.lg,
                                    paddingTop: theme.spacing.sm,
                                    gap: theme.spacing.sm,
                                    borderTopWidth: StyleSheet.hairlineWidth,
                                    borderTopColor: theme.colors.borderSubtle,
                                }}
                            >
                                {footer}
                            </View>
                        ) : null}
                    </View>
                </KeyboardAvoidingView>
            </View>
        </Modal>
    );
}

/**
 * A destructive confirmation.
 *
 * RN's Alert is available, but it renders in the OS's own palette and reads as
 * a system error next to eight themed surfaces — and it cannot show what is
 * about to be lost. Deleting a knowledge base takes its chunks and embeddings
 * with it, which is worth a sentence.
 */
export function ConfirmSheet({
    visible,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
    busy = false,
}: {
    visible: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
}) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <Sheet visible={visible} onClose={onCancel} title={title}>
            <Text variant="body" tone="secondary">
                {message}
            </Text>
            <View style={{ gap: theme.spacing.sm }}>
                <ConfirmButton label={confirmLabel} onPress={onConfirm} busy={busy} />
                <Pressable
                    onPress={onCancel}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel', 'Cancel')}
                    style={{
                        minHeight: theme.minTouch,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <Text variant="body" tone="secondary">
                        {t('common.cancel', 'Cancel')}
                    </Text>
                </Pressable>
            </View>
        </Sheet>
    );
}

function ConfirmButton({
    label,
    onPress,
    busy,
}: {
    label: string;
    onPress: () => void;
    busy: boolean;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={busy ? undefined : onPress}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: busy, busy }}
            style={({ pressed }) => ({
                minHeight: theme.minTouch,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.error,
                opacity: busy ? 0.5 : pressed ? 0.85 : 1,
            })}
        >
            <Text variant="subheading" style={{ color: '#ffffff' }}>
                {label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    dock: { width: '100%' },
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
    },
});
