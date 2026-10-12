/**
 * A file the automation made, handed over: `download` saves or shares it (the
 * share sheet is where "open with", "save to Drive" and "send" live on a
 * phone), `notebook` copies it into a new notebook and opens that.
 *
 * Both are fetched through THIS journey's session — a document another
 * journey produced is a 404. Without an action (a preview) the card is
 * shown inert rather than as a button that leads nowhere.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FillField } from '@/features/forms/model/fillTypes';
import { fileKind, fileSize } from '@/features/forms/model/fillValues';
import { Card, Icon, Spinner, Text } from '@/shared/ui';

import { AnswerRow } from './AnswerRow';
import type { FillActions } from './types';

export function DisplayFile({ field, actions }: { field: FillField; actions: FillActions }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const notebook = field.type === 'notebook';
    const act = notebook ? actions.openInNotebooks : actions.shareFile;
    const meta = [fileKind(field.filename), fileSize(field.size)].filter(Boolean).join(' · ');
    const title = field.filename || (notebook ? t('automations.form_builder_fields.type_notebook', 'Open in Notebooks') : t('mobile.forms.fill.download', 'Download'));
    const run = async () => {
        if (!act || busy) return;
        setBusy(true);
        setError(null);
        try {
            await act(field);
        } catch (err) {
            setError(describeError(err).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <AnswerRow label={field.label} help={field.help} error={error} tight>
            <Card onPress={act ? () => void run() : undefined} accessibilityLabel={title} testID={`fill-file-${field.name}`}>
                <View style={[styles.row, act ? null : styles.inert]}>
                    <View style={styles.badge}>
                        {busy ? <Spinner /> : <Icon name={notebook ? 'BookOpen' : 'Download'} size={16} color={styles.glyph.color} />}
                    </View>
                    <View style={styles.text}>
                        <Text variant="body" weight="medium" numberOfLines={1}>
                            {title}
                        </Text>
                        {meta ? (
                            <Text variant="caption" tone="tertiary">
                                {meta}
                            </Text>
                        ) : null}
                    </View>
                </View>
            </Card>
        </AnswerRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md } satisfies ViewStyle,
    inert: { opacity: 0.65 } satisfies ViewStyle,
    badge: {
        width: 34,
        height: 34,
        borderRadius: theme.radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    text: { flex: 1, minWidth: 0 } satisfies ViewStyle,
    glyph: { color: theme.colors.accentPrimary },
});
