/**
 * "Pick from an app": search the app the question names — in the FILLER's own
 * account — and choose a record. What travels with the answers is a
 * REFERENCE (`{ kind: 'app_pick', recordId, title }`); the server re-reads the
 * record as the person submitting, at submit time.
 *
 * "Nothing found" can mean "you have not connected this app", and the server
 * says which: that reason is printed under the search box, because it is not
 * the person's mistake.
 */

import React, { useEffect, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { pickCap } from '@/features/forms/model/contract';
import type { Answer, FillField, PickAnswer as Pick, PickRow } from '@/features/forms/model/fillTypes';
import { Button, Icon, IconButton, ListRow, SearchField, Sheet, Spinner, Text } from '@/shared/ui';

import { AnswerRow } from './AnswerRow';
import { labelOf, type AnswerProps, type FillActions } from './types';

const DEBOUNCE_MS = 300;

const picksOf = (value: Answer): Pick[] => {
    if (Array.isArray(value)) return value;
    return value && typeof value === 'object' && value.kind === 'app_pick' ? [value] : [];
};

/**
 * The search, debounced, while the sheet is open. What came back is kept
 * with the term it answers, so "searching" is simply "the last answer is for
 * another term" — nothing to switch on and off.
 */
function useAppSearch(field: FillField, search: FillActions['searchApp'], open: boolean, query: string) {
    const [found, setFound] = useState<{ query: string | null; rows: PickRow[]; note: string }>({ query: null, rows: [], note: '' });
    useEffect(() => {
        if (!open || !search) return undefined;
        let live = true;
        const timer = setTimeout(() => {
            search(field, query)
                .then((out) => live && setFound({ query, rows: out.results, note: out.error ?? '' }))
                .catch((err: unknown) => live && setFound({ query, rows: [], note: describeError(err).message }));
        }, DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [open, query, search, field]);
    return { rows: found.rows, note: found.note, searching: open && !!search && found.query !== query };
}

function Results({ field, rows, picked, onAdd }: { field: FillField; rows: PickRow[]; picked: Pick[]; onAdd: (row: PickRow) => void }) {
    return (
        <>
            {rows.map((row) => (
                <ListRow
                    key={row.id}
                    title={row.title || row.id}
                    subtitle={row.subtitle || undefined}
                    onPress={() => onAdd(row)}
                    disabled={picked.some((p) => p.recordId === row.id)}
                    testID={`fill-${field.name}-result-${row.id}`}
                />
            ))}
        </>
    );
}

function SearchSheet({ field, open, onClose, picked, onAdd, search }: {
    field: FillField; open: boolean; onClose: () => void; picked: Pick[]; onAdd: (row: PickRow) => void; search: FillActions['searchApp'];
}) {
    const t = useTranslation();
    const [query, setQuery] = useState('');
    const found = useAppSearch(field, search, open, query);
    const app = field.app || field.sourceLabel;
    const empty = search ? t('mobile.forms.fill.pick_none', 'Nothing found.') : t('mobile.forms.fill.pick_preview', 'The search runs on the live form.');
    return (
        <Sheet visible={open} onClose={onClose} title={app ? t('mobile.forms.fill.pick_from', 'Choose from {app}', { app }) : field.label} tall>
            <SearchField value={query} onChangeText={setQuery} placeholder={field.searchHint || undefined} autoFocus />
            {found.searching ? <Spinner /> : null}
            {!found.searching && (found.note || !found.rows.length) ? (
                <Text variant="caption" tone="tertiary">
                    {found.note || empty}
                </Text>
            ) : null}
            <Results field={field} rows={found.rows} picked={picked} onAdd={onAdd} />
        </Sheet>
    );
}

export function PickAnswer({ field, value, error, disabled, onChange, actions }: AnswerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const picked = picksOf(value);
    const full = picked.length >= pickCap(field);
    const app = field.app || field.sourceLabel;
    const add = (row: PickRow) => {
        const pick: Pick = { kind: 'app_pick', source: field.source, recordId: row.id, title: row.title };
        if (!field.multiple) {
            onChange(pick);
            setOpen(false);
        } else if (!picked.some((p) => p.recordId === row.id)) {
            onChange([...picked, pick]);
        }
    };
    const remove = (recordId: string) => onChange(field.multiple ? picked.filter((p) => p.recordId !== recordId) : null);
    const chooseLabel = picked.length
        ? t('mobile.forms.fill.pick_another', 'Add another from {app}', { app: app || t('mobile.forms.fill.the_app', 'the app') })
        : t('mobile.forms.fill.pick_from', 'Choose from {app}', { app: app || t('mobile.forms.fill.an_app', 'an app') });
    return (
        <AnswerRow label={labelOf(field)} help={field.help} error={error}>
            {picked.map((p) => (
                <View key={p.recordId} style={styles.chip}>
                    <Icon name="Check" size={14} color={styles.glyph.color} />
                    <Text variant="body" numberOfLines={1} style={styles.title}>
                        {p.title || p.recordId}
                    </Text>
                    <IconButton
                        icon={<Icon name="X" size={16} />}
                        accessibilityLabel={t('forms.share.audience_remove', 'Remove {name}', { name: p.title || p.recordId })}
                        onPress={() => remove(p.recordId)}
                        disabled={disabled}
                    />
                </View>
            ))}
            {!full ? <Button variant="secondary" iconName="Search" label={chooseLabel} onPress={() => setOpen(true)} disabled={disabled} testID={`fill-${field.name}`} /> : null}
            <SearchSheet field={field} open={open} onClose={() => setOpen(false)} picked={picked} onAdd={add} search={actions.searchApp} />
        </AnswerRow>
    );
}

const makeStyles = (theme: Theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingLeft: theme.spacing.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
    } satisfies ViewStyle,
    title: { flex: 1, minWidth: 0 },
    glyph: { color: theme.colors.accentPrimary },
});
