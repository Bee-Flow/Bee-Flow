/**
 * Publish this Solution — keep it on this instance as its next version, so
 * colleagues can install it from the catalogue without a file changing hands
 * (the web's export dialog in publish mode).
 *
 * The screen opens this only when the checks said `blocked: false`; the
 * server captures and versions it, and writes the release note itself. A
 * capture that worked but could not be kept says so in the server's words.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Sheet, Text } from '@/shared/ui';

import { Strip } from './Strip';
import { usePublishSolution } from '../hooks/packageMutations';

export function PublishSheet({ projectId, visible, onClose }: { projectId: string; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const publish = usePublishSolution(projectId);
    const result = publish.data;
    const done = Boolean(result && !result.saveError);

    const footer = done ? (
        <Button label={t('common.close', 'Close')} onPress={onClose} fullWidth size="lg" />
    ) : (
        <Button
            label={t('solutions.publish', 'Publish')}
            iconName="Upload"
            onPress={() => publish.mutate()}
            loading={publish.isPending}
            fullWidth
            size="lg"
            testID="publish-confirm"
        />
    );

    return (
        <Sheet visible={visible} onClose={onClose} title={t('solutions.publish_title', 'Publish this Solution')} footer={footer}>
            <View style={styles.stack}>
                <Text variant="body" tone="secondary">
                    {t('solutions.publish_intro', 'A published Solution is kept on this instance, so colleagues can install it without a file changing hands.')}
                </Text>
                {publish.error ? <Banner tone="error">{describeError(publish.error).message}</Banner> : null}
                {result?.saveError ? <Strip tone="error">{result.saveError}</Strip> : null}
                {done ? (
                    <Strip tone="muted" icon="CircleCheck" testID="publish-done">
                        {result?.version
                            ? t('mobile.projects.published_as', 'Published as version {version}.', { version: result.version })
                            : t('projects.blueprint_saved_here', 'Kept on this instance')}
                    </Strip>
                ) : null}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.md } satisfies ViewStyle,
});
