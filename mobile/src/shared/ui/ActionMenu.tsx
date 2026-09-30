/**
 * A menu of actions — the phone's equivalent of the web's AnchoredMenu (the
 * ⋯ menus on rows and headers). A dropdown anchored to a 48dp button does not
 * fit a thumb, so it opens as a bottom sheet: one 48dp row per action, a glyph
 * before each label, a destructive action in the error ink, and Cancel.
 *
 * Choosing an action closes the menu first and then runs it, so an action that
 * opens a sheet of its own (a ConfirmSheet for "Delete…") does not stack on a
 * menu that is still there.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon, type IconName } from './icons/Icon';
import { Text } from './Text';

export interface ActionMenuItem {
    /** Stable key; the label when omitted. */
    id?: string;
    label: string;
    icon?: IconName;
    onPress: () => void;
    /** Drawn in the error ink: this removes or ends something. */
    destructive?: boolean;
    disabled?: boolean;
    /** Marks the current choice when the menu picks one of several (a sort, a view). */
    selected?: boolean;
    /** Read by a screen reader after the label, for an action whose effect the label does not say. */
    accessibilityHint?: string;
}

export interface ActionMenuProps {
    visible: boolean;
    onClose: () => void;
    /** A small uppercase label over the actions, usually the object's name. */
    title?: string;
    items: readonly ActionMenuItem[];
    testID?: string;
}

export function ActionMenu({ visible, onClose, title, items, testID }: ActionMenuProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const insets = useSafeAreaInsets();

    const choose = (item: ActionMenuItem) => {
        if (item.disabled) return;
        onClose();
        item.onPress();
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.root}>
                <Pressable
                    style={styles.backdrop}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close', 'Close')}
                />
                <View
                    accessibilityViewIsModal
                    testID={testID}
                    style={[styles.panel, { paddingBottom: insets.bottom + 8 }]}
                >
                    {title ? (
                        <Text variant="label" weight="semibold" style={styles.title} numberOfLines={1}>
                            {title}
                        </Text>
                    ) : null}
                    {/* Scrolls when the list is longer than the screen allows (a card's
                        menu can hold a dozen entries), so the top ones stay reachable. */}
                    <ScrollView accessibilityRole="menu" style={styles.list} bounces={false}>
                        {items.map((item) => (
                            <ActionRow key={item.id ?? item.label} item={item} onChoose={choose} styles={styles} />
                        ))}
                    </ScrollView>
                    <View style={styles.divider} />
                    <Pressable
                        onPress={onClose}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.row, styles.cancel, pressed ? styles.pressed : null]}
                    >
                        <Text variant="body" weight="medium" tone="secondary">
                            {t('common.cancel', 'Cancel')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}

type Styles = ReturnType<typeof makeStyles>;

function ActionRow({
    item,
    onChoose,
    styles,
}: {
    item: ActionMenuItem;
    onChoose: (item: ActionMenuItem) => void;
    styles: Styles;
}) {
    const ink = item.destructive ? styles.danger : styles.ink;
    return (
        <Pressable
            onPress={() => onChoose(item)}
            disabled={item.disabled}
            accessibilityRole="menuitem"
            accessibilityLabel={item.label}
            accessibilityHint={item.accessibilityHint}
            accessibilityState={{ disabled: item.disabled, selected: item.selected }}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, item.disabled ? styles.disabled : null]}
        >
            {item.icon ? (
                <Icon name={item.icon} size={18} color={item.destructive ? styles.danger.color : styles.glyph.color} />
            ) : null}
            <Text variant="body" style={[styles.label, ink]} numberOfLines={1}>
                {item.label}
            </Text>
            {item.selected ? <Icon name="Check" size={16} color={styles.check.color} /> : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    root: { flex: 1, justifyContent: 'flex-end' } satisfies ViewStyle,
    list: { flexGrow: 0, flexShrink: 1 } satisfies ViewStyle,
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)' } satisfies ViewStyle,
    panel: {
        backgroundColor: theme.colors.bgSecondary,
        borderTopLeftRadius: theme.radii.lg,
        borderTopRightRadius: theme.radii.lg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.borderDefault,
        boxShadow: theme.shadows.popover,
        paddingTop: theme.spacing[2],
        maxHeight: '88%',
    } satisfies ViewStyle,
    title: {
        color: theme.colors.textTertiary,
        letterSpacing: 0.55,
        textTransform: 'uppercase',
        paddingHorizontal: theme.spacing[5],
        paddingTop: theme.spacing[2],
        paddingBottom: theme.spacing[1],
    } satisfies TextStyle,
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: theme.minTouch,
        paddingHorizontal: theme.spacing[5],
    } satisfies ViewStyle,
    cancel: { justifyContent: 'center' } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.45 } satisfies ViewStyle,
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.borderSubtle,
        marginVertical: theme.spacing[1],
    } satisfies ViewStyle,
    label: { flex: 1 } satisfies TextStyle,
    ink: { color: theme.colors.textPrimary } satisfies TextStyle,
    danger: { color: theme.colors.errorInk } satisfies TextStyle,
    glyph: { color: theme.colors.textSecondary },
    check: { color: theme.colors.accentText },
});
