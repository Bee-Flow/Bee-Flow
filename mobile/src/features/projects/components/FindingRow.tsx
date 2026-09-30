/**
 * One thing the checks found — the web's SolutionFindingRow: the sentence the
 * server wrote, where on the ladder it blocks, what to do about it, and a
 * "Show me" only where the server could name a thing to open. A validator
 * that saw only a definition has no id, and a button to nowhere is worse
 * than no button.
 */

import React from 'react';
import type { ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, Text, tonePair } from '@/shared/ui';

import { GlyphRow } from './GlyphRow';
import { isBlocking } from '../model/checks';
import type { Finding } from '../model/solution';

function ladderWords(blockedAt: string | null, t: TranslateFn): string | null {
    if (blockedAt === 'activate') return t('mobile.projects.blocks_activate', 'blocks turning it on');
    if (blockedAt === 'publish') return t('mobile.projects.blocks_publish', 'blocks publishing');
    return null;
}

export function FindingRow({ finding, onOpen }: { finding: Finding; onOpen: (link: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const blocking = isBlocking(finding);
    const detail = [ladderWords(finding.blockedAt, t), finding.remediation].filter(Boolean).join(' · ');
    return (
        <GlyphRow
            glyph={<Icon name="TriangleAlert" size={16} color={blocking ? styles.ink.error : styles.ink.warning} />}
            text={finding.message}
            testID="solution-finding"
        >
            {detail ? (
                <Text variant="caption" tone="tertiary">
                    {detail}
                </Text>
            ) : null}
            {finding.deepLink ? (
                <Button
                    label={t('solutions.show_me', 'Show me')}
                    variant="ghost"
                    size="sm"
                    iconName="ExternalLink"
                    onPress={() => onOpen(finding.deepLink as string)}
                    style={styles.open}
                    testID="solution-finding-open"
                />
            ) : null}
        </GlyphRow>
    );
}

const makeStyles = (theme: Theme) => ({
    open: { alignSelf: 'flex-start' } satisfies ViewStyle,
    ink: { error: tonePair(theme.colors, 'error').ink, warning: tonePair(theme.colors, 'warning').ink },
});
