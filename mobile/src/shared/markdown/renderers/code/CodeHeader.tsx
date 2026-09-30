/**
 * The code block's header bar: "● Python" on the left and Copy on the right,
 * which reads "Copied" in green for two seconds after a tap — the web's bar.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon } from '@/shared/ui';

import { CODE_PANEL } from './codeTheme';

const styles = StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 10,
        paddingRight: 4,
        minHeight: 32,
        backgroundColor: CODE_PANEL.headerBackground,
        borderBottomWidth: 1,
        borderBottomColor: CODE_PANEL.headerBorder,
    },
    label: { fontSize: 11, fontWeight: '600', color: CODE_PANEL.headerText },
    dot: { opacity: 0.6 },
    copy: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
    copyText: { fontSize: 11, fontWeight: '500', color: CODE_PANEL.headerText },
    copiedText: { color: CODE_PANEL.copied },
});

const COPIED_FOR_MS = 2000;

export function CodeHeader({ label, code }: { label: string; code: string }) {
    const { t, copy } = useMarkdownEnv();
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const name = label || t('mobile.markdown.code', 'Code');
    return (
        <View style={styles.bar}>
            <Text style={styles.label}>
                <Text style={styles.dot}>{'● '}</Text>
                {name}
            </Text>
            <Pressable
                onPress={() => {
                    copy(code);
                    setCopied(true);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.markdown.copy_code', 'Copy code')}
                hitSlop={8}
                style={styles.copy}
            >
                <Icon name={copied ? 'Check' : 'Copy'} size={12} color={copied ? CODE_PANEL.copied : CODE_PANEL.headerText} />
                <Text style={[styles.copyText, copied && styles.copiedText]}>
                    {copied ? t('mobile.markdown.copied', 'Copied') : t('chat.copy', 'Copy')}
                </Text>
            </Pressable>
        </View>
    );
}
