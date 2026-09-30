/**
 * The organisation logo (OrgInfoSection.jsx "Logo"): the current image, or
 * the web's dashed placeholder, with Upload and — when there is one — Remove.
 * Both act at once, as on the web; they are not part of the form's SaveBar.
 */

import { Image } from 'expo-image';
import React from 'react';
import { View, type ImageStyle, type ViewStyle } from 'react-native';

import { apiUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Group, Icon } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import { serverImageUri } from '../model/profile';

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg } satisfies ViewStyle,
    frame: {
        width: 80,
        height: 80,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgTertiary,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.spacing.sm,
    } satisfies ViewStyle,
    empty: { borderStyle: 'dashed', borderWidth: 2 } satisfies ViewStyle,
    image: { width: '100%', height: '100%' } satisfies ImageStyle,
    actions: { flex: 1, gap: theme.spacing.sm, alignItems: 'flex-start' } satisfies ViewStyle,
});

export function LogoGroup({
    logo,
    busy,
    onUpload,
    onRemove,
}: {
    logo: string | null | undefined;
    busy: boolean;
    onUpload: () => void;
    onRemove: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const uri = serverImageUri(logo, apiUrl);
    return (
        <Group
            title={t('org.logo', 'Logo')}
            footer={t('org.logo_hint', 'Displayed in the UI header and exports. PNG or SVG, max 500×200px.')}
        >
            <FieldRow>
                <View style={styles.row}>
                    <View style={uri ? styles.frame : [styles.frame, styles.empty]}>
                        {uri ? (
                            <Image
                                testID="org-logo"
                                source={{ uri }}
                                style={styles.image}
                                contentFit="contain"
                                accessibilityLabel={t('org.logo', 'Logo')}
                            />
                        ) : (
                            <Icon name="Building2" size={32} color={theme.colors.textMuted} />
                        )}
                    </View>
                    <View style={styles.actions}>
                        <Button
                            label={t('org.upload_logo', 'Upload Logo')}
                            iconName="Upload"
                            size="sm"
                            loading={busy}
                            disabled={busy}
                            onPress={onUpload}
                        />
                        {uri ? (
                            <Button
                                label={t('org.remove_logo', 'Remove logo')}
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onPress={onRemove}
                            />
                        ) : null}
                    </View>
                </View>
            </FieldRow>
        </Group>
    );
}
