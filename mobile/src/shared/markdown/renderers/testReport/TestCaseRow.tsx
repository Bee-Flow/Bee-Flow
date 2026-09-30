/**
 * One test: a row with the chevron, its status icon and name, and beneath
 * the name its category chip, severity and duration (the web puts those at
 * the row's end; a phone has no room there). Tapped open, the row tints in
 * its status colour and shows the description, the numbered steps, the error
 * in monospace and the screenshot.
 */

import { Image } from 'expo-image';
import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon, Text, tint } from '@/shared/ui';

import type { TestCase } from './testReportModel';
import { CATEGORY_ICON, STATUS_ICON } from './testWords';
import { answerImage } from '../image/answerImage';
import { TEST_CATEGORY, TEST_SEVERITY, TEST_STATUS } from '../rich/richPalette';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        row: { borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.borderSubtle, overflow: 'hidden' },
        head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2], padding: theme.spacing[3] },
        titles: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
        meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing[2] },
        chip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
        severity: { textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700', fontSize: 10 },
        detail: { gap: theme.spacing[3], padding: theme.spacing[3], paddingLeft: theme.spacing[8] },
        heading: { textTransform: 'uppercase', letterSpacing: 0.5 },
        error: { borderRadius: 8, padding: theme.spacing[2.5], borderWidth: 1, gap: theme.spacing[1] },
        errorText: { ...theme.fonts.mono, fontSize: 12.5, color: '#fca5a5' },
        shot: { width: '100%', height: 220, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle },
    }),
);

function color(value: string) {
    return { color: value };
}

function chip(value: string): ViewStyle {
    return { backgroundColor: tint(value, 10) };
}

function openTint(test: TestCase, open: boolean): ViewStyle {
    const status = TEST_STATUS[test.status];
    return open ? { borderColor: `${status.color}30`, backgroundColor: status.bg } : {};
}

function errorBox(): ViewStyle {
    return { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)' };
}

function Detail({ test }: { test: TestCase }) {
    const styles = useThemedStyles(sheet);
    const { t } = useMarkdownEnv();
    const screenshot = test.screenshot ? answerImage(test.screenshot) : null;
    return (
        <View style={styles.detail}>
            {test.description ? <Text variant="caption" tone="secondary">{test.description}</Text> : null}
            {test.steps.length ? (
                <View>
                    <Text variant="label" tone="tertiary" style={styles.heading}>{t('mobile.markdown.test_steps', 'Steps')}</Text>
                    {test.steps.map((step, i) => (
                        <Text key={i} variant="caption" tone="secondary">{`${i + 1}. ${step}`}</Text>
                    ))}
                </View>
            ) : null}
            {test.error ? (
                <View style={[styles.error, errorBox()]}>
                    <Text variant="label" style={color(TEST_STATUS.failed.color)}>{`❌ ${t('common.error', 'Error')}`}</Text>
                    <Text selectable style={styles.errorText}>{test.error}</Text>
                </View>
            ) : null}
            {screenshot ? <Image source={screenshot} style={styles.shot} contentFit="contain" /> : null}
        </View>
    );
}

export function TestCaseRow({ test, open, onToggle }: { test: TestCase; open: boolean; onToggle: () => void }) {
    const styles = useThemedStyles(sheet);
    const { theme } = useMarkdownEnv();
    const status = TEST_STATUS[test.status];
    const category = test.category ? TEST_CATEGORY[test.category] : null;
    return (
        <View style={[styles.row, openTint(test, open)]}>
            <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.head}>
                <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} color={theme.colors.textMuted} />
                <Icon name={STATUS_ICON[test.status]} size={16} color={status.color} />
                <View style={styles.titles}>
                    <Text variant="caption" weight="medium">{test.name}</Text>
                    <View style={styles.meta}>
                        {test.category && category ? (
                            <View style={[styles.chip, chip(category)]}>
                                <Icon name={CATEGORY_ICON[test.category]} size={11} color={category} />
                                <Text variant="label" style={color(category)}>{test.category}</Text>
                            </View>
                        ) : null}
                        {test.severity ? (
                            <Text style={[styles.severity, color(TEST_SEVERITY[test.severity])]}>{test.severity}</Text>
                        ) : null}
                        {test.duration ? <Text variant="label" tone="tertiary">{test.duration}</Text> : null}
                    </View>
                </View>
            </Pressable>
            {open ? <Detail test={test} /> : null}
        </View>
    );
}
