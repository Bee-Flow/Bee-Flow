/** "Add" in the ＋ sheet: the three attachment sources, each closing the sheet first. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Icon } from '@/shared/ui';

import { ContextSectionLabel } from './ContextSectionLabel';

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, gap: theme.spacing.sm },
});

export function ContextAttach({
    onClose,
    onDocument,
    onImage,
    onCamera,
}: {
    onClose: () => void;
    onDocument?: () => void;
    onImage?: () => void;
    onCamera?: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const then = (pick: () => void) => () => {
        onClose();
        pick();
    };
    const icon = (name: 'Camera' | 'Image' | 'File') => (
        <Icon name={name} size={12} color={theme.colors.textSecondary} />
    );

    return (
        <View>
            <ContextSectionLabel hint={t('mobile.chat.attach_hint', 'Rides along with this message.')}>
                {t('chat.composer.tools_attach', 'Add photos & files')}
            </ContextSectionLabel>
            <View style={styles.row}>
                {onCamera ? <Chip label={t('mobile.chat.attach_camera', 'Camera')} onPress={then(onCamera)} icon={icon('Camera')} /> : null}
                {onImage ? <Chip label={t('mobile.chat.attach_photo', 'Photo')} onPress={then(onImage)} icon={icon('Image')} /> : null}
                {onDocument ? (
                    <Chip label={t('mobile.chat.attach_document', 'Document')} onPress={then(onDocument)} icon={icon('File')} />
                ) : null}
            </View>
        </View>
    );
}
