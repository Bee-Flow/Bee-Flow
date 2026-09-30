/**
 * The web's UserFilterBar for one organisation: the search, role and status
 * as pill rows, and the "Clear" the web offers once any filter is on. Above
 * the list rather than inside it, so a filter that empties the list can still
 * be cleared.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, FilterPills, SearchField, Text, type FilterPillOption } from '@/shared/ui';

import { filtersActive, NO_FILTERS, type MemberFilters } from '../model/members';
import { roleCopy } from '../model/roles';

export function MemberFilterBar({
    filters,
    onChange,
    roleIds,
    shown,
    total,
}: {
    filters: MemberFilters;
    onChange: (next: MemberFilters) => void;
    /** 'user' plus the org roles, in picker order. */
    roleIds: string[];
    shown: number;
    total: number;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const roles: FilterPillOption<string>[] = [
        { value: 'all', label: t('admin.org_all_roles', 'All roles') },
        ...roleIds.map((id) => ({ value: id, label: roleCopy(id, t).name })),
    ];
    const statuses: FilterPillOption<string>[] = [
        { value: 'all', label: t('admin.org_all_statuses', 'Any status') },
        { value: 'active', label: t('admin.org_status_active', 'Active') },
        { value: 'pending', label: t('admin.org_status_pending', 'Pending'), tone: 'warning' },
    ];
    return (
        <View style={styles.bar}>
            <SearchField
                value={filters.search}
                onChangeText={(search) => onChange({ ...filters, search })}
                placeholder={t('admin.org_search_users', 'Search by name or email…')}
            />
            <FilterPills
                scroll
                testID="member-role-filter"
                accessibilityLabel={t('admin.org_all_roles', 'All roles')}
                value={filters.role}
                onChange={(role) => onChange({ ...filters, role })}
                options={roles}
            />
            <FilterPills
                testID="member-status-filter"
                accessibilityLabel={t('admin.org_all_statuses', 'Any status')}
                value={filters.status}
                onChange={(status) => onChange({ ...filters, status })}
                options={statuses}
            />
            {filtersActive(filters) ? (
                <View style={styles.summary}>
                    <Text variant="caption" tone="tertiary" style={styles.count}>
                        {t('mobile.orgPeople.showing', '{shown} of {total}', { shown, total })}
                    </Text>
                    <Button
                        size="sm"
                        variant="ghost"
                        label={t('admin.org_clear_filters', 'Clear')}
                        onPress={() => onChange({ ...NO_FILTERS })}
                    />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing.sm },
        summary: { flexDirection: 'row', alignItems: 'center' },
        count: { flex: 1 },
    });
