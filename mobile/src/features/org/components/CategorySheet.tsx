/**
 * Which PII categories the shield looks for. An empty selection means ALL of
 * them — the widest protection — so "Select all" clears the list.
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Chip, Sheet, Text } from '@/shared/ui';

import { EMPTY_MEANS_ALL, PII_CATEGORIES, PII_GROUPS } from '../model/piiCategories';

export function CategorySheet({
    visible,
    onClose,
    selected,
    saving,
    onSave,
}: {
    visible: boolean;
    onClose: () => void;
    selected: string[];
    saving: boolean;
    onSave: (categories: string[]) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const [draft, setDraft] = useState<string[]>(selected);

    // Re-seed whenever the sheet opens: the stored list may have changed since
    // this component last rendered (another device, or a save that landed).
    const key = useMemo(() => selected.join('|'), [selected]);
    const [seededFor, setSeededFor] = useState(key);
    if (visible && seededFor !== key) {
        setSeededFor(key);
        setDraft(selected);
    }

    const toggle = (id: string) =>
        setDraft((previous) =>
            previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id],
        );

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="What counts as personal data"
            subtitle={
                draft.length === 0 ? 'Nothing selected means everything' : `${draft.length} categories`
            }
            footer={
                <View style={styles.footer}>
                    <Button
                        label="Select all"
                        variant="ghost"
                        onPress={() => setDraft([])}
                        style={styles.footerButton}
                    />
                    <Button
                        label="Save"
                        onPress={() => onSave(draft)}
                        loading={saving}
                        style={styles.footerButton}
                    />
                </View>
            }
        >
            <View style={styles.body}>
                <Text variant="caption" tone="tertiary">
                    {EMPTY_MEANS_ALL}
                </Text>
                {PII_GROUPS.map((group) => {
                    const items = PII_CATEGORIES.filter((c) => c.group === group);
                    if (items.length === 0) return null;
                    return (
                        <View key={group} style={styles.group}>
                            <Text variant="label" tone="tertiary">
                                {group.toUpperCase()}
                            </Text>
                            <View accessibilityRole="list" style={styles.chips}>
                                {items.map((category) => (
                                    <Chip
                                        key={category.id}
                                        label={category.label}
                                        selected={draft.includes(category.id)}
                                        onPress={() => toggle(category.id)}
                                    />
                                ))}
                            </View>
                        </View>
                    );
                })}
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { flexDirection: 'row', gap: theme.spacing.sm },
        footerButton: { flex: 1 },
        body: { gap: theme.spacing.lg },
        group: { gap: theme.spacing.sm },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });
