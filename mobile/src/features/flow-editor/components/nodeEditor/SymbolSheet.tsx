/**
 * The symbols a step may wear — the web's IconPicker popover
 * (Builder/flow/stepIcons.jsx) as a sheet: a search over the names, the
 * grid in the web's order, and "Default" to go back to the type's own glyph.
 * The list is the fixed STEP_ICON_NAMES, so a grid of all of it is bounded.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { STEP_ICON_NAMES } from '@/features/flow-editor/model';
import { Button, Icon, SearchField, Sheet, Text, tint, type IconName } from '@/shared/ui';

/** The names whose spelling holds the query, in picker order. */
export function symbolMatches(query: string): readonly string[] {
    const q = query.trim().toLowerCase();
    return q ? STEP_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)) : STEP_ICON_NAMES;
}

export function SymbolSheet({
    visible,
    value,
    onPick,
    onClose,
}: {
    visible: boolean;
    /** The step's own symbol, '' for none. */
    value: string;
    /** A name, or '' for the type's own glyph. */
    onPick: (name: string) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [query, setQuery] = useState('');
    const results = symbolMatches(query);
    const pick = (name: string) => {
        setQuery('');
        onPick(name);
    };
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('automations.settings_form.choose_a_symbol_for_this_step', 'Choose a symbol for this step')}
            footer={<Button variant="secondary" label={t('mobile.flow.ndv.symbol_default', 'Default')} onPress={() => pick('')} disabled={!value} />}
        >
            <SearchField value={query} onChangeText={setQuery} placeholder={t('automations.step_icons.search_symbols', 'Search symbols…')} />
            <View style={styles.grid}>
                {results.map((name) => (
                    <Pressable
                        key={name}
                        onPress={() => pick(name)}
                        style={[styles.cell, value === name ? styles.selected : null]}
                        accessibilityRole="button"
                        accessibilityLabel={name}
                        accessibilityState={{ selected: value === name }}
                        testID={`symbol-${name}`}
                    >
                        <Icon name={name as IconName} size={20} color={value === name ? styles.on.color : styles.off.color} />
                    </Pressable>
                ))}
            </View>
            {results.length === 0 ? (
                <Text variant="caption" tone="tertiary" center>
                    {t('automations.step_icons.no_matches', 'No matches')}
                </Text>
            ) : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[1], paddingTop: theme.spacing.md } satisfies ViewStyle,
    cell: { width: 44, height: 44, borderRadius: theme.radii.md, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
    selected: { backgroundColor: tint(theme.colors.accentPrimary, 15), borderWidth: 1, borderColor: tint(theme.colors.accentPrimary, 40) } satisfies ViewStyle,
    on: { color: theme.colors.accentText },
    off: { color: theme.colors.textSecondary },
});
