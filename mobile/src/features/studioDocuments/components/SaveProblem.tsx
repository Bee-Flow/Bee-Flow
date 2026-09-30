/**
 * The body did not save. What was typed is kept (the autosave holds it), and
 * the two ways out are the web's: try again, or — when the document changed
 * elsewhere in the meantime — go back to what is stored.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import type { DocumentEditor } from '../hooks/useDocumentEditor';

export function SaveProblem({ editor }: { editor: DocumentEditor }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { autosave, query, reload } = editor;
    if (autosave.state !== 'error') return null;
    const refresh = async () => {
        // Dropped first: the refetch brings the new versionId, and a body
        // still pending would then pass the conflict check and overwrite it.
        autosave.discard();
        await query.refetch();
        reload();
    };
    return (
        <View style={styles.wrap}>
            <Banner tone="error">
                <View style={styles.body}>
                    <Text variant="caption">{describeError(autosave.error).message}</Text>
                    <View style={styles.actions}>
                        <Button label={t('mobile.studio_documents.retry', 'Retry save')} size="sm" variant="secondary" onPress={() => void autosave.flush().catch(() => undefined)} />
                        <Button label={t('mobile.studio_documents.reload', 'Reload the stored version')} size="sm" variant="ghost" onPress={() => void refresh()} />
                    </View>
                </View>
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    wrap: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[3] } satisfies ViewStyle,
    body: { gap: theme.spacing[2] } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] } satisfies ViewStyle,
});
