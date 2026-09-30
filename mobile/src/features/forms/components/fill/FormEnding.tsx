/**
 * The last screen of a journey — the web's FormEndingView: a single-page
 * form's thank-you, or a closing page the server rendered against the
 * finished run, whose text can be what the routine actually produced.
 *
 * A long closing (a summary, a draft, an analysis) is a document, and it is
 * gone once the screen closes — so it gets the export bar: share it as a
 * .txt, copy it, or save it into a new notebook. Files the routine made are
 * handed over below it.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { shareText } from '@/core/api/shareFile';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { isDisplayField } from '@/features/forms/model/contract';
import type { FillForm } from '@/features/forms/model/fillTypes';
import { isLongEnding, txtFilename } from '@/features/forms/model/fillValues';
import { Markdown } from '@/shared/markdown';
import { Button, Icon, Text } from '@/shared/ui';

import { DisplayFile } from './DisplayFile';
import type { FillActions } from './types';

function ExportBar({ text, title, onSaveToNotebook }: { text: string; title: string; onSaveToNotebook?: () => Promise<void> }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const save = async () => {
        if (!onSaveToNotebook || saving) return;
        setSaving(true);
        setError(null);
        try {
            await onSaveToNotebook();
        } catch (err) {
            setError(describeError(err).message);
        } finally {
            setSaving(false);
        }
    };
    return (
        <View style={styles.bar} testID="fill-export">
            <View style={styles.actions}>
                <Button size="sm" variant="secondary" iconName="Share2" label={t('mobile.forms.fill.share_text', 'Share as .txt')} onPress={() => void shareText(text, txtFilename(title))} />
                <Button
                    size="sm"
                    variant="secondary"
                    iconName={copied ? 'Check' : 'Copy'}
                    label={copied ? t('mobile.forms.fill.copied', 'Copied') : t('mobile.forms.fill.copy_text', 'Copy text')}
                    onPress={() => void Clipboard.setStringAsync(text).then(() => setCopied(true))}
                />
                {onSaveToNotebook ? (
                    <Button size="sm" variant="secondary" iconName="BookOpen" loading={saving} label={t('mobile.forms.fill.save_notebook', 'Save to Notebook')} onPress={() => void save()} />
                ) : null}
            </View>
            {error ? (
                <Text variant="caption" tone="error">
                    {error}
                </Text>
            ) : null}
        </View>
    );
}

export function FormEnding({ form, actions = {}, onSaveToNotebook }: { form: FillForm | null; actions?: FillActions; onSaveToNotebook?: () => Promise<void> }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const description = form?.description ?? '';
    const long = isLongEnding(description);
    const title = form?.title || t('mobile.forms.fill.thanks', 'Thanks — we got your answer.');
    return (
        <View style={[styles.card, long ? null : styles.centred]} testID="fill-ending">
            <View style={styles.tick}>
                <Icon name="Check" size={22} color={styles.tickGlyph.color} />
            </View>
            <Text variant="subheading" center>
                {title}
            </Text>
            {description ? <Markdown value={description} /> : null}
            {long ? <ExportBar text={description} title={form?.title ?? ''} onSaveToNotebook={onSaveToNotebook} /> : null}
            {(form?.fields ?? []).filter(isDisplayField).map((field) => (
                <DisplayFile key={field.name} field={field} actions={actions} />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.md,
        padding: theme.spacing.xl,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    centred: { alignItems: 'center' } satisfies ViewStyle,
    tick: {
        alignSelf: 'center',
        width: 44,
        height: 44,
        borderRadius: theme.radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accentPrimary,
    } satisfies ViewStyle,
    tickGlyph: { color: theme.colors.accentPrimaryFg },
    bar: { gap: theme.spacing.xs } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
});
