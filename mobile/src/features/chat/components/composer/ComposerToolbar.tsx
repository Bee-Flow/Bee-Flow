/**
 * The line under the message: ＋ on the left; dictation, the shield's claim,
 * the tier gauge and send on the right — send adjacent to the gauge exactly
 * where the web places it.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { ShieldWords } from '@/features/chat/model/shieldLine';
import { Icon, IconButton } from '@/shared/ui';

import { DictationButton } from './DictationButton';
import { SendButton } from './SendButton';
import { ShieldButton } from './ShieldButton';
import { TierDial, type TierDialProps } from './TierDial';

export interface ComposerToolbarProps {
    disabled: boolean;
    streaming: boolean;
    canSend: boolean;
    onPlus: () => void;
    onSubmit: () => void;
    /** Where dictated words go; absent, no microphone. */
    onDictated?: (text: string) => void;
    shield?: ShieldWords | null;
    dial: Omit<TierDialProps, 'disabled'>;
}

export function ComposerToolbar({ disabled, streaming, canSend, onPlus, onSubmit, onDictated, shield, dial }: ComposerToolbarProps) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <View style={toolbar.row}>
            {/* One "+", always shown: files, a knowledge base, a skill and the
                tools, where the web's "+" already has people looking. */}
            <IconButton
                icon={<Icon name="Plus" size={20} color={theme.colors.textSecondary} />}
                accessibilityLabel={t('chat.composer.tools_menu', 'Message tools')}
                onPress={onPlus}
                disabled={disabled}
            />
            <View style={toolbar.spacer} />
            {onDictated ? <DictationButton onText={onDictated} disabled={disabled} /> : null}
            <ShieldButton line={shield ?? null} />
            <TierDial {...dial} disabled={disabled} />
            <SendButton streaming={streaming} canSend={canSend} onPress={onSubmit} />
        </View>
    );
}

const toolbar = StyleSheet.create({
    // `center`, not `flex-end`: the toolbar is its own line under the input
    // rather than a row the input sits inside.
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    spacer: { flex: 1 },
});
