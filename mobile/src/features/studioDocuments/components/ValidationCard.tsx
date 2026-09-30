/** The server's verdict on the customer values: ready, or what is still missing and which sections apply. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Banner, Text } from '@/shared/ui';

import { makeEditorStyles } from './editorStyles';
import { sectionStateLabel } from '../model/format';
import type { ValidationResult } from '../model/types';

export function ValidationCard({ result }: { result: ValidationResult }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    return (
        <View style={styles.block} testID="document-validation">
            <Banner tone={result.valid ? 'success' : 'warning'}>
                {result.valid
                    ? t('mobile.studio_documents.values.ready', 'Ready to generate')
                    : t('mobile.studio_documents.values.draft', 'Draft — input required')}
            </Banner>
            {result.issues.map((issue, index) => (
                <Text key={`${issue.code}:${index}`} variant="caption" tone="error">
                    {issue.message}
                </Text>
            ))}
            {result.sections.map((s) => (
                <Text key={s.id} variant="caption" tone="secondary">
                    {`${s.title}: ${sectionStateLabel(t, s.state)} — ${s.reason}`}
                </Text>
            ))}
        </View>
    );
}
