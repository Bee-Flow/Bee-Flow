/**
 * `$…$` inside a line of text: the typeset formula as an inline view, lowered
 * by its depth so its baseline sits on the text's (React Native puts an inline
 * view's bottom on the baseline). Without an engine, or for a formula that
 * does not parse, the TeX itself in the code-span style — readable, and what
 * the author wrote.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { useMarkdownEnv } from '@/shared/markdown/env';

import { inlineMathStyle } from './mathLayout';
import { renderTex } from './renderTex';

export function InlineMath({ tex }: { tex: string }) {
    const { theme, styles } = useMarkdownEnv();
    const math = renderTex(tex, false, theme.type.body.fontSize);
    if (!math) return <Text style={styles.codespan}>{` ${tex} `}</Text>;
    return (
        <View style={inlineMathStyle(math)} accessible accessibilityLabel={tex}>
            <SvgXml xml={math.xml} width={math.width} height={math.height} color={theme.colors.textPrimary} />
        </View>
    );
}
