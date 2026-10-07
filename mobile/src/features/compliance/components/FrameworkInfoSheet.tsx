/**
 * A framework's sheet, opened by tapping its row on More frameworks: the
 * full description, what it affects, and where its dates come from with
 * the "checked on" review line (SourcesGroup; on the web the sources sit on
 * the framework's Timeline tab).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Sheet, Text } from '@/shared/ui';

import { frameworkName } from './FrameworkRow';
import { SourcesGroup } from './SourcesGroup';
import type { Framework } from '../api/hubReaders';
import { frameworkMeta } from '../model/frameworkCard';

export function FrameworkInfoSheet({ framework, onClose }: { framework: Framework | null; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const fw = framework;
    return (
        <Sheet visible={fw !== null} onClose={onClose} title={fw ? frameworkName(fw, t) : ''} subtitle={fw ? frameworkMeta(fw, t) || undefined : undefined}>
            {fw ? (
                <View style={styles.body} testID={`framework-sheet-${fw.id}`}>
                    {fw.description_key ? (
                        <Text variant="body" tone="secondary">
                            {t(fw.description_key, '')}
                        </Text>
                    ) : null}
                    {fw.affects_key ? (
                        <Text variant="caption" tone="tertiary">
                            {`${t('compliance.fw_affects_label', 'Affects you:')} ${t(fw.affects_key, '')}`}
                        </Text>
                    ) : null}
                    <SourcesGroup sources={fw.sources} review={fw.legal_review} />
                </View>
            ) : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing[3] },
    });
