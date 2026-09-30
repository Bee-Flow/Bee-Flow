/**
 * "Add a person or group" — the organisation's directory, searchable, with
 * whoever is already on the list left out. A directory this account may not
 * read (it is an admin's list in some organisations) says so instead of
 * showing an empty one.
 */

import React, { createContext, useContext, useMemo, useState } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { Grantee, GranteeType } from '@/features/forms/model/audience';
import { SearchField, Segmented, Sheet, Text } from '@/shared/ui';

import { GranteeRow } from './GranteeRow';

export interface DirectoryEntry {
    id: string;
    name: string;
    detail: string;
}

export interface AudienceDirectory {
    users: DirectoryEntry[];
    groups: DirectoryEntry[];
    error: unknown;
}

const matches = (entry: DirectoryEntry, needle: string) => `${entry.name} ${entry.detail}`.toLowerCase().includes(needle);

/** The kind being picked and the pick handler, for the module-level renderItem. */
const PickContext = createContext<{ type: GranteeType; onPick: (grantee: Grantee) => void }>({ type: 'user', onPick: () => undefined });

function DirectoryRow({ entry }: { entry: DirectoryEntry }) {
    const { type, onPick } = useContext(PickContext);
    return <GranteeRow type={type} name={entry.name} detail={entry.detail} onPress={() => onPick({ type, id: entry.id })} />;
}

const renderItem: ListRenderItem<DirectoryEntry> = ({ item }) => <DirectoryRow entry={item} />;

export function AudiencePickerSheet({
    visible,
    onClose,
    directory,
    taken,
    onPick,
}: {
    visible: boolean;
    onClose: () => void;
    directory: AudienceDirectory;
    taken: readonly Grantee[];
    onPick: (grantee: Grantee) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [type, setType] = useState<GranteeType>('user');
    const [query, setQuery] = useState('');
    const needle = query.trim().toLowerCase();
    const pool = type === 'user' ? directory.users : directory.groups;
    const rows = pool.filter((e) => !taken.some((g) => g.type === type && g.id === e.id)).filter((e) => !needle || matches(e, needle));
    const pick = useMemo(() => ({ type, onPick }), [type, onPick]);
    return (
        <Sheet visible={visible} onClose={onClose} title={t('forms.share.audience_add', 'Add a person or group')} tall scroll={false}>
            <View style={styles.body}>
                <Segmented
                    value={type}
                    onChange={setType}
                    fullWidth
                    accessibilityLabel={t('forms.share.audience_kind', 'A person or a group')}
                    options={[
                        { value: 'user', label: t('forms.share.audience_person', 'A person') },
                        { value: 'group', label: t('forms.share.audience_group_short', 'A group') },
                    ]}
                />
                <SearchField
                    value={query}
                    onChangeText={setQuery}
                    placeholder={type === 'user' ? t('forms.share.audience_pick_person', 'Pick someone…') : t('forms.share.audience_pick_group', 'Pick a group…')}
                />
                {directory.error ? (
                    <Text variant="caption" tone="tertiary">
                        {describeError(directory.error).message}
                    </Text>
                ) : null}
            </View>
            <PickContext.Provider value={pick}>
                <FlatList
                    data={rows}
                    keyExtractor={(entry) => `${type}:${entry.id}`}
                    keyboardShouldPersistTaps="handled"
                    renderItem={renderItem}
                />
            </PickContext.Provider>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.sm, paddingBottom: theme.spacing.sm } satisfies ViewStyle,
});
