/**
 * The overview's cards for one project tab — "From us" or "Installed" — with
 * the sentence that says how much they are worth above them.
 *
 * A FAILED READ IS NOT AN EMPTY WORKSPACE: QueryList shows the error state for
 * a failed summary, and the empty state is reachable only from a successful
 * one. Gaps that hit every card are said once, above the cards.
 */

import React from 'react';
import { StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList, type ListQuery } from '@/shared/patterns';

import { SolutionCard } from './SolutionCard';
import { Strip } from './Strip';
import { tabOf, type OverviewTab } from '../model/overview';
import type { SolutionRow, SolutionSummary } from '../model/solution';
import { sectionNames } from '../model/words';

const rowKey = (row: SolutionRow) => row.id;

function Notices({ summary }: { summary: SolutionSummary | undefined }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const gaps = sectionNames(summary?.unavailable, t);
    if (!summary || (gaps.length === 0 && !summary.hasMore)) return null;
    return (
        <View style={styles.notices}>
            {gaps.length > 0 ? (
                <Strip tone="warning" testID="solutions-overview-partial">
                    {t('solutions.overview_partial', 'Not all of this could be read: {sections}. What is missing is left blank on the cards rather than shown as nothing.', {
                        sections: gaps.join(', '),
                    })}
                </Strip>
            ) : null}
            {summary.hasMore ? (
                <Strip tone="muted">
                    {t('solutions.overview_more', 'Only the {count} most recently changed Solutions are shown here.', { count: summary.rows.length })}
                </Strip>
            ) : null}
        </View>
    );
}

export function SolutionList({
    query,
    tab,
    onOpen,
}: {
    query: Omit<ListQuery<SolutionRow>, 'data'> & { data: SolutionSummary | undefined };
    tab: OverviewTab;
    onOpen: (row: SolutionRow) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const renderItem: ListRenderItem<SolutionRow> = ({ item }) => (
        <View style={styles.cell}>
            <SolutionCard row={item} onOpen={onOpen} />
        </View>
    );
    return (
        <QueryList
            query={{ ...query, data: query.data?.rows }}
            keyExtractor={rowKey}
            renderItem={renderItem}
            filter={(row) => tabOf(row) === tab}
            separator="none"
            search={{
                placeholder: t('mobile.projects.search', 'Search Solutions'),
                match: (row, needle) => `${row.name} ${row.description}`.toLowerCase().includes(needle),
            }}
            ListHeaderComponent={<Notices summary={query.data} />}
            empty={
                tab === 'installed'
                    ? {
                          icon: 'Download',
                          title: t('solutions.tab_installed', 'Installed'),
                          message: t('solutions.installed_empty', 'Nothing here came from a Blueprint yet. Install one from the Catalogue, or from a file.'),
                      }
                    : {
                          icon: 'Package',
                          title: t('solutions.title', 'Solutions'),
                          message: t('solutions.empty', 'Nothing here yet. Create a Solution, or install a Blueprint someone handed you.'),
                      }
            }
            noMatch={{
                title: t('mobile.projects.no_match', 'No Solution matches that'),
                message: t('mobile.projects.no_match_hint', 'Try another word.'),
                clearLabel: t('automations.mapping.clear_search', 'Clear search'),
            }}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        notices: { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        cell: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    });
