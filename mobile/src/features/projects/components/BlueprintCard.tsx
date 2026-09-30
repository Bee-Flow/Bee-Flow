/** One Blueprint in the catalogue — the web's catalogue card: tile, name, version, what it is, Install. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Text } from '@/shared/ui';

import { CardHead } from './CardHead';
import type { BlueprintMeta } from '../model/package';

export function BlueprintCard({ blueprint, onInstall }: { blueprint: BlueprintMeta; onInstall: (b: BlueprintMeta) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card testID={`blueprint-card-${blueprint.id}`}>
            <View style={styles.stack}>
                <CardHead
                    icon={blueprint.icon}
                    name={blueprint.name}
                    sub={t('solutions.blueprint_version', 'Blueprint v{version}', { version: blueprint.version })}
                />
                {blueprint.description ? (
                    <Text variant="caption" tone="secondary" numberOfLines={2}>
                        {blueprint.description}
                    </Text>
                ) : null}
                <Button
                    label={t('solutions.install_confirm', 'Install')}
                    variant="secondary"
                    size="sm"
                    iconName="Download"
                    onPress={() => onInstall(blueprint)}
                    style={styles.button}
                    testID={`blueprint-install-${blueprint.id}`}
                />
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stack: { gap: theme.spacing[2.5] },
        button: { alignSelf: 'flex-start' },
    });
