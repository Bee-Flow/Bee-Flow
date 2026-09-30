/**
 * A one- or two-line fence with no language: the web draws it as the inline
 * code chip, wrapping, with no header (BFSF-273) — a copied prompt or a path,
 * not a program. Long-press copies it, as there is no Copy button.
 */

import React from 'react';
import { Text } from 'react-native';

import { useMarkdownEnv } from '@/shared/markdown/env';

export function CompactCode({ code }: { code: string }) {
    const { styles, copy, t } = useMarkdownEnv();
    return (
        <Text
            style={styles.codespan}
            onLongPress={() => copy(code, true)}
            accessibilityHint={t('mobile.markdown.copy_hint', 'Long press to copy')}
        >
            {code}
        </Text>
    );
}
