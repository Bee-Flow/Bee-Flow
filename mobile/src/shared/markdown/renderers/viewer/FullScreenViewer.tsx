/**
 * Something from an answer opened over the whole screen — a picture (the
 * web's ImageLightbox) or a diagram (the web's Mermaid "Full View") — on a
 * dark backdrop, zoomable, with its actions and Close along the top.
 *
 * A Modal is its own Android window, outside the app's gesture root and
 * outside the toast host, so it brings a GestureHandlerRootView of its own and
 * says what an action did in a line of its own rather than in a toast.
 */

import React, { type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Text, type IconName } from '@/shared/ui';

import { ZoomView } from './ZoomView';

const INK = 'rgba(255,255,255,0.85)';

const styles = StyleSheet.create({
    fill: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.92)' },
    stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    bar: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
    },
    title: { flex: 1, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 40,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
    },
    actionText: { color: INK },
    status: {
        position: 'absolute',
        left: 16,
        right: 16,
        alignItems: 'center',
    },
    statusText: { color: INK, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
});

export interface ViewerAction {
    icon: IconName;
    label: string;
    onPress: () => void;
    /** Only the icon on the button; the label is for TalkBack. */
    iconOnly?: boolean;
}

function barAt(top: number) {
    return { top: top + 8 };
}

function statusAt(bottom: number) {
    return { bottom: bottom + 24 };
}

function ActionButton({ action }: { action: ViewerAction }) {
    return (
        <Pressable onPress={action.onPress} accessibilityRole="button" accessibilityLabel={action.label} style={styles.action}>
            <Icon name={action.icon} size={16} color={INK} />
            {action.iconOnly ? null : (
                <Text variant="caption" weight="medium" style={styles.actionText}>
                    {action.label}
                </Text>
            )}
        </Pressable>
    );
}

export function FullScreenViewer({
    visible,
    title,
    actions,
    status,
    onClose,
    closeLabel,
    children,
}: {
    visible: boolean;
    title?: string;
    actions: ViewerAction[];
    status?: string | null;
    onClose: () => void;
    closeLabel: string;
    children: ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const all: ViewerAction[] = [...actions, { icon: 'X', label: closeLabel, onPress: onClose, iconOnly: true }];
    return (
        <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
            <GestureHandlerRootView style={styles.fill}>
                <View style={styles.backdrop}>
                    <ZoomView>
                        <View style={styles.stage}>{children}</View>
                    </ZoomView>
                    <View style={[styles.bar, barAt(insets.top)]}>
                        <Text variant="label" style={styles.title} numberOfLines={1}>
                            {title ?? ''}
                        </Text>
                        {all.map((action) => (
                            <ActionButton key={action.label} action={action} />
                        ))}
                    </View>
                    {status ? (
                        <View style={[styles.status, statusAt(insets.bottom)]} pointerEvents="none" accessibilityLiveRegion="polite">
                            <Text variant="caption" style={styles.statusText}>
                                {status}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
}
