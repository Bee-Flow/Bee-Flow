/**
 * The strip over the builder chat: how the builder edits, and New chat.
 *
 * Two segments, as on the web (WebpageChat.jsx): "Edit automatically" is
 * `auto`; "Propose first" is `ask`, which also stands for the server's `plan`
 * — both stop before touching a file and ask, which is the only distinction a
 * person makes here.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Button, Segmented } from '@/shared/ui';

import type { ChatMode } from '../model/chat';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
        },
        grow: { flex: 1 },
    });

export function BuildModeBar({
    mode,
    onMode,
    canStartOver,
    onStartOver,
}: {
    mode: ChatMode;
    onMode: (mode: ChatMode) => void;
    canStartOver: boolean;
    onStartOver: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const confirm = useConfirm();

    const startOver = async () => {
        const ok = await confirm({
            title: t('mobile.webpages.chat.new_confirm_title', 'Start a new chat?'),
            message: t('mobile.webpages.chat.new_confirm', 'The current conversation will be cleared.'),
            confirmLabel: t('mobile.webpages.chat.new', 'New chat'),
        });
        if (ok) onStartOver();
    };

    return (
        <View style={styles.bar}>
            <View style={styles.grow}>
                <Segmented
                    value={mode}
                    onChange={onMode}
                    accessibilityLabel={t('mobile.webpages.chat.mode', 'How the assistant edits')}
                    options={[
                        { value: 'auto', label: t('mobile.webpages.chat.mode_auto', 'Edit automatically') },
                        { value: 'ask', label: t('mobile.webpages.chat.mode_ask', 'Propose first') },
                    ]}
                    fullWidth
                />
            </View>
            <Button
                label={t('mobile.webpages.chat.new', 'New chat')}
                variant="ghost"
                size="sm"
                iconName="Plus"
                disabled={!canStartOver}
                onPress={() => void startOver()}
            />
        </View>
    );
}
