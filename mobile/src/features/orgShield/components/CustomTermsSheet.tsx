/**
 * The org's own words and patterns to hide on top of what the detector finds
 * — project code names, contract-number shapes. They keep working without
 * the detection service. A list, then one term at a time.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, EmptyState, ListRow, Sheet, Text } from '@/shared/ui';

import { TermEditor } from './TermEditor';
import { newTermId, upsertTerm } from '../model/terms';
import type { CustomTerm, ShieldSaveResult } from '../model/types';

type TermErrors = ShieldSaveResult['termErrors'];

interface TermItem {
    term: CustomTerm;
    error: boolean;
    onPress: () => void;
}

const keyOf = (item: TermItem) => item.term.id;

function TermRow({ term, error, onPress }: TermItem) {
    const t = useTranslation();
    return (
        <ListRow
            title={term.label}
            subtitle={term.pattern}
            meta={error ? t('mobile.orgShield.term_refused', 'Refused on the last save') : undefined}
            onPress={onPress}
            chevron
            testID={`term-${term.id}`}
        />
    );
}

const renderItem: ListRenderItem<TermItem> = ({ item }) => <TermRow {...item} />;

export function CustomTermsSheet({
    visible,
    terms,
    termErrors,
    onChange,
    onClose,
}: {
    visible: boolean;
    terms: CustomTerm[];
    termErrors: TermErrors;
    onChange: (next: CustomTerm[]) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [editing, setEditing] = useState<CustomTerm | null>(null);
    const errorFor = (id: string) => termErrors.find((e) => e.id === id)?.error ?? null;
    const items: TermItem[] = terms.map((term) => ({
        term,
        error: Boolean(errorFor(term.id)),
        onPress: () => setEditing(term),
    }));
    const close = () => {
        setEditing(null);
        onClose();
    };
    const add = () => setEditing({ id: newTermId(), label: '', pattern: '', type: 'literal', caseSensitive: false });
    return (
        <Sheet visible={visible} onClose={close} title={t('mobile.orgShield.terms_title', 'Always hide these')} tall scroll={editing !== null}>
            {editing ? (
                <TermEditor
                    term={editing}
                    terms={terms}
                    serverError={errorFor(editing.id)}
                    onSave={(next) => {
                        onChange(upsertTerm(terms, next));
                        setEditing(null);
                    }}
                    onDelete={(id) => {
                        onChange(terms.filter((x) => x.id !== id));
                        setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={keyOf}
                    renderItem={renderItem}
                    ListHeaderComponent={
                        <View style={styles.header}>
                            <Text variant="caption" tone="secondary">
                                {t('mobile.orgShield.terms_desc', 'Anything of your own that the list above will not catch — project code names, contract number formats, internal system names. These are hidden on top of everything else.')}
                            </Text>
                            <Button label={t('common.add', 'Add')} iconName="Plus" onPress={add} testID="term-add" />
                        </View>
                    }
                    ListEmptyComponent={<EmptyState icon="EyeOff" title={t('mobile.orgShield.terms_empty', 'Nothing added yet.')} />}
                />
            )}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
    });
