/**
 * "Now running · last 24 hours" — the card at the top of Runs & log, the
 * web's NowRunningStrip.jsx. One line per routine: a dot, the name, one
 * phrase, and how long ago.
 *
 * Three states that may not borrow each other's look: LOADING (the first
 * read), UNREADABLE (the rollup is null — never drawn as "nothing is
 * running") and READ (possibly empty, which is a real answer). A routine name
 * opens its automation only in "my runs": in the organisation scope it is a
 * colleague's routine, which the automation screen refuses.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Icon, Spinner, Text, type TextTone } from '@/shared/ui';

import { nowRunningLines, type NowRunningLine, type NowRunningTone } from '../model/nowRunning';
import { errorClassWords } from '../model/runLanguage';
import type { RunFacets } from '../model/types';

/** A counted phrase: the base key for one, `<key>_plural` otherwise (the web's nOf). */
function nOf(t: TranslateFn, key: string, count: number, en: { one: string; many: string }): string {
    return count === 1 ? t(key, en.one, { count }) : t(`${key}_plural`, en.many, { count });
}

function lineText(line: NowRunningLine, t: TranslateFn): string {
    if (line.tone === 'error') {
        const why = errorClassWords(line.errorClass);
        return why
            ? t('runs.now.failed_because', 'failed — {reason}', { reason: t(why.key, why.en) })
            : t('runs.now.failed', 'failed');
    }
    if (line.tone === 'waiting') return nOf(t, 'runs.now.waiting', line.waiting, { one: 'waiting for a person', many: '{count} waiting for a person' });
    if (line.tone === 'running') return nOf(t, 'runs.now.running', line.running, { one: 'running now', many: '{count} running now' });
    return nOf(t, 'runs.now.done', line.total, { one: 'done · {count} run', many: 'done · {count} runs' });
}

const INK: Record<NowRunningTone, TextTone> = { error: 'error', waiting: 'warning', running: 'secondary', done: 'tertiary' };

function StripLine({ line, onOpen }: { line: NowRunningLine; onOpen: ((automationId: string) => void) | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const title = line.title || t('runs.now.untitled', 'A routine without a name');
    const name = (
        <Text variant="caption" weight="medium" numberOfLines={1} style={styles.name}>
            {title}
        </Text>
    );
    return (
        <View style={styles.line} testID="now-running-line">
            <View style={[styles.dot, styles[line.tone]]} />
            {onOpen ? (
                <Pressable onPress={() => onOpen(line.automationId)} accessibilityRole="link" style={styles.nameBox}>
                    {name}
                </Pressable>
            ) : (
                <View style={styles.nameBox}>{name}</View>
            )}
            <Text variant="caption" tone={INK[line.tone]} numberOfLines={1} style={styles.phrase}>
                {lineText(line, t)}
            </Text>
            <Text variant="label" tone="tertiary">
                {timeAgo(line.at)}
            </Text>
        </View>
    );
}

function StripBody({ facets, loading, failed, onOpen }: NowRunningStripProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const model = nowRunningLines(facets);
    if (loading && !model) return <Spinner />;
    if (!model) {
        return (
            <View style={styles.line} testID="now-running-unknown">
                <Icon name="CircleAlert" size={14} color={theme.colors.warning} />
                <Text variant="caption" tone="secondary" style={styles.phrase}>
                    {failed
                        ? t('runs.now.unreadable', 'Could not read what is running — this is not “nothing is running”.')
                        : t('runs.now.unsupported', 'This server did not report per-routine activity, so this strip has nothing to show. The runs below are unaffected.')}
                </Text>
            </View>
        );
    }
    if (model.lines.length === 0) {
        return (
            <Text variant="caption" tone="tertiary" testID="now-running-empty">
                {t('runs.now.empty', 'Nothing has run in the last 24 hours.')}
            </Text>
        );
    }
    return (
        <>
            {model.lines.map((line) => (
                <StripLine key={line.automationId} line={line} onOpen={onOpen} />
            ))}
            {model.hidden > 0 ? (
                <Text variant="label" tone="tertiary">
                    {nOf(t, 'runs.now.more', model.hidden, { one: 'and {count} more routine', many: 'and {count} more routines' })}
                </Text>
            ) : null}
        </>
    );
}

export interface NowRunningStripProps {
    facets: RunFacets | null | undefined;
    /** True only while the first read is in flight. */
    loading: boolean;
    failed: boolean;
    onOpen: ((automationId: string) => void) | null;
}

export function NowRunningStrip(props: NowRunningStripProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card style={styles.card} testID="now-running">
            <View style={styles.head}>
                <Icon name="History" size={16} color={theme.colors.textSecondary} />
                <Text variant="subheading" style={styles.phrase}>
                    {t('runs.now.title', 'Now running')}
                </Text>
                <Text variant="caption" tone="tertiary">
                    {t('runs.now.window', 'last 24 hours')}
                </Text>
            </View>
            <StripBody {...props} />
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    card: { gap: theme.spacing[2.5] },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    line: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    dot: { width: 8, height: 8, borderRadius: 4 },
    // The dot per state: the tone's raw colour, the accent for "running".
    error: { backgroundColor: theme.colors.error },
    waiting: { backgroundColor: theme.colors.warning },
    running: { backgroundColor: theme.colors.accentPrimary },
    done: { backgroundColor: theme.colors.success },
    nameBox: { maxWidth: '45%' as const },
    name: { color: theme.colors.textPrimary },
    phrase: { flex: 1 },
});
