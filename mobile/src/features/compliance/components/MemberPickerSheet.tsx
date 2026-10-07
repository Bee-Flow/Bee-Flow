/**
 * Pick one member or several (web: UserPicker / the owner select): a
 * searchable list over the org's member directory. Names only, with the
 * e-mail added when two members share a name (model/memberOptions.ts); a
 * stored id that is no longer a member keeps a '—' row; a field that is not
 * required offers 'Nobody selected'. Single mode picks and closes; multi mode
 * toggles and closes with Done.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, NoteRow, OptionRow, SearchField, Sheet } from '@/shared/ui';

import { useMembers } from '../hooks/members';
import { memberOptions, type MemberOption } from '../model/memberOptions';

export interface MemberPickerSheetProps {
    title: string;
    /** The ids chosen so far ('' or [] for nobody). */
    value: string | readonly string[];
    multi?: boolean;
    required?: boolean;
    onChange: (next: string | string[]) => void;
    onClose: () => void;
    testID?: string;
}

const NOBODY = '';

export function MemberPickerSheet({ title, value, multi = false, required = false, onChange, onClose, testID = 'member-picker' }: MemberPickerSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const members = useMembers(true);
    const [needle, setNeedle] = useState('');
    const chosen = typeof value === 'string' ? (value ? [value] : []) : [...value];
    const all = memberOptions(members.data, chosen);
    const q = needle.trim().toLowerCase();
    const rows: MemberOption[] = [
        ...(!multi && !required && !q ? [{ value: NOBODY, label: t('compliance.set_no_user', 'Nobody selected') }] : []),
        ...all.filter((o) => !q || o.label.toLowerCase().includes(q)),
    ];

    const press = (id: string) => {
        if (!multi) {
            onChange(id);
            onClose();
            return;
        }
        onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
    };

    return (
        <Sheet
            visible
            tall
            scroll={false}
            onClose={onClose}
            title={title}
            footer={multi ? <Button testID={`${testID}-done`} label={t('chat.composer.kb_done', 'Done')} onPress={onClose} /> : undefined}
        >
            <View style={styles.search}>
                <SearchField value={needle} onChangeText={setNeedle} placeholder={t('common.search', 'Search')} />
            </View>
            <FlatList
                testID={testID}
                data={rows}
                keyExtractor={(o) => o.value || 'nobody'}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    <NoteRow>{members.isLoading ? t('compliance.mob_loading', 'Loading…') : t('compliance.rail_search_empty', 'Nothing matches')}</NoteRow>
                }
                renderItem={({ item }) => (
                    <OptionRow
                        testID={`${testID}-${item.value || 'nobody'}`}
                        label={item.label}
                        selected={item.value === NOBODY ? chosen.length === 0 : chosen.includes(item.value)}
                        onPress={() => press(item.value)}
                    />
                )}
            />
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => StyleSheet.create({ search: { paddingBottom: theme.spacing.sm } });
