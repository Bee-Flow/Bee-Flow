/**
 * The line under a question the shield changed (the web's PrivacyLine.jsx):
 * how many values were replaced, the placeholders themselves where the
 * answer's token map proves which ones stand for words in THIS message, and
 * an honest "this screen cannot show which" where it does not.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { describePrivacyLine } from '@/features/chat/model/privacyLine';
import { Text } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    token: { ...theme.fonts.mono, backgroundColor: theme.colors.bgTertiary, color: theme.colors.textSecondary },
});

function sentenceKey(line: NonNullable<ReturnType<typeof describePrivacyLine>>): { key: string; en: string } {
    if (line.form === 'unproven') {
        return line.count === 1
            ? { key: 'mobile.chat.privacy_line_unproven', en: '1 value was replaced before this went to the AI — this screen cannot show which placeholder took its place' }
            : { key: 'mobile.chat.privacy_line_unproven_plural', en: '{count} values were replaced before this went to the AI — this screen cannot show which placeholders took their place' };
    }
    if (line.partial) {
        return { key: 'dlp.line_replaced_partial', en: '{count} values were replaced before this went to the AI. {tokens} stands for a value in this message — that real value stayed here' };
    }
    return line.count === 1
        ? { key: 'mobile.chat.privacy_line_replaced', en: '1 value replaced with {tokens} — the real value stayed here' }
        : { key: 'mobile.chat.privacy_line_replaced_plural', en: '{count} values replaced with {tokens} — the real values stayed here' };
}

export function PrivacyLineText({
    count,
    messageText,
    tokenMap,
    scanIncomplete,
}: {
    count: number;
    messageText: string;
    tokenMap: Record<string, string> | null | undefined;
    scanIncomplete: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const line = describePrivacyLine({ count, messageText, tokenMap, scanIncomplete });
    if (!line) return null;

    const words = sentenceKey(line);
    const sentence = t(words.key, words.en, { count: line.count });
    const at = sentence.indexOf('{tokens}');
    const before = at === -1 ? sentence : sentence.slice(0, at);
    const after = at === -1 ? '' : sentence.slice(at + '{tokens}'.length);

    return (
        <Text variant="label" tone="tertiary">
            {'🔒 '}
            {before}
            {line.tokens.map((token, i) => (
                <Text key={token} variant="label" style={styles.token}>
                    {i > 0 ? `, ${token}` : token}
                </Text>
            ))}
            {after}
            {line.incomplete
                ? ` ${t('dlp.line_scan_incomplete', 'Part of this message could not be checked, and that part was sent as it was.')}`
                : ''}
        </Text>
    );
}
