/**
 * A framework's checks (web: pages/FrameworkPage, the Checks tab): the open
 * ones first, a filter for "needs attention" and all, and a row per check that
 * opens its result, history and evidence.
 */

import { useRouter } from 'expo-router';
import React, { createContext, useContext, useState } from 'react';
import { StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Badge, FilterPills, ListRow } from '@/shared/ui';

import type { CheckRow as Check } from '../api/readers';
import { useChecks } from '../hooks/queries';
import { checkKey, checkMeta, checkTitle, isOpenCheck, sortChecks } from '../model/checks';
import { CHECK_STATUSES } from '../model/choices';
import { choiceOf, labelText } from '../model/fields';
import { recordRoute } from '../model/navigation';

const SectionContext = createContext('');

function CheckItem({ check }: { check: Check }) {
    const t = useTranslation();
    const router = useRouter();
    const section = useContext(SectionContext);
    const status = choiceOf(CHECK_STATUSES, check.status);
    return (
        <ListRow
            testID={`check-${checkKey(check)}`}
            title={checkTitle(check, t)}
            subtitle={checkMeta(check, t)}
            trailing={status ? <Badge label={labelText(status.label, t)} tone={status.tone ?? 'neutral'} /> : undefined}
            chevron
            onPress={() => router.push(recordRoute(section, checkKey(check)))}
        />
    );
}

const renderItem: ListRenderItem<Check> = ({ item }) => <CheckItem check={item} />;
const keyOf = (item: Check) => checkKey(item);

type Filter = 'open' | 'all';

export function CheckList({ section, framework }: { section: string; framework: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const checks = useChecks(framework, true);
    const [filter, setFilter] = useState<Filter>('all');
    const rows = checks.data ? sortChecks(checks.data) : undefined;
    const open = rows?.filter(isOpenCheck).length ?? null;

    return (
        <SectionContext.Provider value={section}>
            <QueryList
                query={{ ...checks, data: rows }}
                renderItem={renderItem}
                keyExtractor={keyOf}
                filter={filter === 'open' ? isOpenCheck : undefined}
                search={{ placeholder: t('compliance.rail_search_placeholder', 'Search checks, articles or registers…'), match: (c, needle) => checkTitle(c, t).toLowerCase().includes(needle) || (c.article ?? '').toLowerCase().includes(needle) }}
                empty={{ icon: 'ListChecks', title: t('compliance.ovw_headline_pending', 'Score after the first run') }}
                noMatch={{ title: t('compliance.rail_search_empty', 'Nothing matches') }}
                ListHeaderComponent={
                    <View style={styles.filters}>
                        <FilterPills
                            testID="check-filter"
                            value={filter}
                            onChange={setFilter}
                            options={[
                                { value: 'all', label: t('compliance.soa_filter_all', 'All'), count: rows?.length ?? null },
                                { value: 'open', label: t('compliance.mob_needs_attention', 'Needs attention'), count: open, tone: open ? 'warning' : 'neutral' },
                            ]}
                        />
                    </View>
                }
            />
        </SectionContext.Provider>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ filters: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing[3] } });
