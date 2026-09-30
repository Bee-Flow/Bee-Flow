/**
 * The billing-country select as a sheet: a search over the web's country list
 * (virtualised — it has some two hundred rows) with "Select a country" first,
 * which clears the field as the web's empty option does.
 */

import React, { useState } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { OptionRow, SearchField, Sheet } from '@/shared/ui';

import { COUNTRIES, type Country } from '../model/countries';

type Row = Country & { selected: boolean; onPick: (code: string) => void };

const renderCountry: ListRenderItem<Row> = ({ item }) => (
    <OptionRow label={item.name} selected={item.selected} onPress={() => item.onPick(item.code)} />
);

const keyOf = (row: Row) => row.code || 'none';

export function CountrySheet({
    visible,
    value,
    onPick,
    onClose,
}: {
    visible: boolean;
    value: string;
    onPick: (code: string) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const pick = (code: string) => {
        onPick(code);
        setQuery('');
        onClose();
    };
    const rows: Row[] = [{ code: '', name: t('org.select_country', 'Select a country') }, ...COUNTRIES]
        .filter((c) => !q || !c.code || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q)
        .map((c) => ({ ...c, selected: c.code === value, onPick: pick }));
    return (
        <Sheet visible={visible} onClose={onClose} title={t('org.country', 'Country')} scroll={false} tall>
            <SearchField value={query} onChangeText={setQuery} placeholder={t('mobile.org.country_search', 'Search countries')} />
            <FlatList data={rows} renderItem={renderCountry} keyExtractor={keyOf} keyboardShouldPersistTaps="handled" />
        </Sheet>
    );
}
