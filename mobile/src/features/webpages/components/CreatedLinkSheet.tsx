/**
 * The address a new link got, shown now rather than trusted to the list: on a
 * server without MASTER_ENCRYPTION_KEY the raw token is not kept, and this is
 * the only time it can be seen.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, Text } from '@/shared/ui';

import { LinkActions } from './LinkActions';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.md } });

export function CreatedLinkSheet({
    url,
    pageName,
    onClose,
}: {
    url: string | null;
    pageName: string;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Sheet
            visible={url !== null}
            onClose={onClose}
            title={t('mobile.webpages.link.created', 'Link created')}
            subtitle={t('mobile.webpages.link.created_hint', 'Anyone with this address can open the page')}
            footer={<Button label={t('mobile.webpages.link.done', 'Done')} size="lg" fullWidth onPress={onClose} />}
        >
            <View style={styles.body}>
                <LinkActions
                    url={url ?? ''}
                    shareTitle={pageName || t('mobile.webpages.link.share_title', 'Bee Flow page')}
                />
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.webpages.link.copy_now',
                        'Copy it now. It normally stays available in the list below, but on a server without a master encryption key an address can only be shown once.',
                    )}
                </Text>
            </View>
        </Sheet>
    );
}
