/** The owner's way out: delete the page, behind a confirmation, at the bottom. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Section, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.md } });

export function DangerZone({ onDelete }: { onDelete: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Section title={t('mobile.webpages.danger.title', 'Danger zone')}>
            <Card>
                <View style={styles.body}>
                    <Text variant="caption" tone="tertiary">
                        {t(
                            'mobile.webpages.danger.body',
                            'Deleting takes the page, every version of it, its external links and any knowledge base created for it. There is no undo.',
                        )}
                    </Text>
                    <Button
                        label={t('mobile.webpages.menu.delete', 'Delete page')}
                        variant="danger"
                        onPress={onDelete}
                    />
                </View>
            </Card>
        </Section>
    );
}
