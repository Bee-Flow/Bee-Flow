/**
 * The Blueprints kept on this instance, ready to install — the overview's
 * Catalogue tab. Loaded when the tab opens, not with the screen: most visits
 * never come here, and the list is org-wide. An empty catalogue and one that
 * could not be listed are different states (QueryList's empty and error).
 */

import React from 'react';
import { StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Text } from '@/shared/ui';

import { BlueprintCard } from './BlueprintCard';
import { useBlueprints } from '../hooks/solutionQueries';
import type { BlueprintMeta } from '../model/package';

const blueprintKey = (b: BlueprintMeta) => b.id;

export function CatalogueList({ onInstall }: { onInstall: (blueprint: BlueprintMeta) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const catalogue = useBlueprints();
    const renderItem: ListRenderItem<BlueprintMeta> = ({ item }) => (
        <View style={styles.cell}>
            <BlueprintCard blueprint={item} onInstall={onInstall} />
        </View>
    );
    return (
        <QueryList
            query={catalogue}
            keyExtractor={blueprintKey}
            renderItem={renderItem}
            separator="none"
            ListHeaderComponent={
                <Text variant="caption" tone="tertiary" style={styles.intro}>
                    {t('solutions.catalogue_intro', 'Installing one of these creates a new Solution. Everything arrives as a draft.')}
                </Text>
            }
            empty={{
                icon: 'Package',
                title: t('solutions.tab_catalogue', 'Catalogue'),
                message: t(
                    'solutions.catalogue_empty',
                    'No Blueprints are kept on this instance yet. Publish a Solution and it appears here for colleagues to install.',
                ),
            }}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        intro: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
        cell: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    });
