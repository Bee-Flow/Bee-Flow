/**
 * The Privacy Shield's claim beside send (the web's shield line in the
 * composer toolbar): a lock in the success colour while the shield is
 * checking, in the warning colour when it is on but cannot check right now.
 * A tap says the sentence; nothing at all when the status is unknown.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { ShieldWords } from '@/features/chat/model/shieldLine';
import { Icon, IconButton, useToast } from '@/shared/ui';


export function ShieldButton({ line }: { line: ShieldWords | null }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    if (!line) return null;
    const words = t(line.i18nKey, line.en);
    const ok = line.tone === 'ok';
    return (
        <IconButton
            icon={<Icon name={ok ? 'ShieldCheck' : 'ShieldAlert'} size={18} color={ok ? theme.colors.success : theme.colors.warning} />}
            accessibilityLabel={words}
            onPress={() => toast(words, ok ? 'success' : 'neutral')}
        />
    );
}
