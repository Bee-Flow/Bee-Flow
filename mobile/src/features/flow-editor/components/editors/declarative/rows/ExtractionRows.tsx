/**
 * Extract data's field rows — the web's DataExtractionFields rows
 * (actionEditors/dataExtractionFields.jsx) in the web's own words
 * (`routines.ndv.extraction.*`): a lower-snake name that becomes the output
 * key, its type, required, and what to look for. A name typed with spaces
 * becomes one (`Invoice Date` → `invoice_date`) as it is typed; a duplicate is
 * marked and not saved until it has a name of its own (formState drops it).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { moveRow, SelectField, ToggleField } from '@/features/flow-editor/components/fields';
import {
    coerceExtractionName,
    emptyExtractionField,
    EXTRACTION_FIELD_TYPES,
    MAX_EXTRACTION_FIELDS,
    type ExtractionField,
} from '@/features/flow-editor/formState';
import { Button, Icon, IconButton, Text, TextField } from '@/shared/ui';

/** An example name, as the web's field shows one. */
const NAME_EXAMPLE = 'invoice_date';

/** Is row `i`'s name already taken by an earlier row? */
export function isDuplicateName(rows: readonly ExtractionField[], i: number): boolean {
    const name = rows[i]?.name || '';
    return !!name && rows.findIndex((r) => (r?.name || '') === name) !== i;
}

type Styles = ReturnType<typeof makeStyles>;

function RowTools({ i, count, onMove, onRemove, styles }: { i: number; count: number; onMove: (dir: -1 | 1) => void; onRemove: () => void; styles: Styles }) {
    const t = useTranslation();
    const glyph = styles.glyph.color;
    return (
        <View style={styles.tools}>
            <IconButton icon={<Icon name="ChevronUp" size={16} color={glyph} />} accessibilityLabel={t('mobile.flow.list.up', 'Move up')} disabled={i === 0} onPress={() => onMove(-1)} />
            <IconButton icon={<Icon name="ChevronDown" size={16} color={glyph} />} accessibilityLabel={t('mobile.flow.list.down', 'Move down')} disabled={i === count - 1} onPress={() => onMove(1)} />
            <IconButton icon={<Icon name="Trash2" size={16} color={glyph} />} accessibilityLabel={t('mobile.flow.extraction.remove', 'Remove field')} onPress={onRemove} />
        </View>
    );
}

function Row({ rows, i, onChange, styles }: { rows: ExtractionField[]; i: number; onChange: (next: ExtractionField[]) => void; styles: Styles }) {
    const t = useTranslation();
    const f = rows[i] as ExtractionField;
    const update = (patch: Partial<ExtractionField>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    const duplicate = isDuplicateName(rows, i);
    return (
        <View style={styles.row} testID="extraction-field-row">
            <View style={styles.head}>
                <TextField
                    value={f.name}
                    onChangeText={(v) => update({ name: coerceExtractionName(v) })}
                    placeholder={NAME_EXAMPLE}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={t('routines.ndv.extraction.field_name', 'Name')}
                    error={duplicate ? t('mobile.flow.extraction.duplicate', 'Another field is already called {name} — this one is not saved until it has its own name.', { name: f.name }) : null}
                    containerStyle={styles.name}
                />
                <RowTools i={i} count={rows.length} onMove={(dir) => onChange(moveRow(rows, i, dir))} onRemove={() => onChange(rows.filter((_, k) => k !== i))} styles={styles} />
            </View>
            <SelectField
                label={t('routines.ndv.extraction.field_type', 'Type')}
                value={EXTRACTION_FIELD_TYPES.includes(f.type) ? f.type : 'string'}
                options={EXTRACTION_FIELD_TYPES.map((type) => ({ value: type, label: type }))}
                onChange={(type) => update({ type })}
            />
            <TextField
                label={t('routines.ndv.extraction.field_desc', 'What to look for')}
                value={f.description}
                onChangeText={(description) => update({ description })}
            />
            <ToggleField value={f.required === true} onChange={(required) => update({ required })} label={t('routines.ndv.extraction.required', 'Required')} />
        </View>
    );
}

export function ExtractionRows({ value, onChange }: { value: unknown; onChange: (next: ExtractionField[]) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const rows = Array.isArray(value) ? (value as ExtractionField[]) : [];
    const full = rows.length >= MAX_EXTRACTION_FIELDS;
    return (
        <View style={styles.list}>
            {rows.map((_, i) => (
                <Row key={i} rows={rows} i={i} onChange={onChange} styles={styles} />
            ))}
            <View style={styles.add}>
                <Button
                    size="sm"
                    variant="secondary"
                    iconName="Plus"
                    label={t('routines.ndv.extraction.add_field', 'Add field')}
                    disabled={full}
                    onPress={() => onChange([...rows, emptyExtractionField()])}
                />
            </View>
            {full ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.extraction.max', 'At most {n} fields per step', { n: MAX_EXTRACTION_FIELDS })}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.md } satisfies ViewStyle,
    row: {
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs } satisfies ViewStyle,
    name: { flex: 1 } satisfies ViewStyle,
    tools: { flexDirection: 'row' } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    add: { flexDirection: 'row' } satisfies ViewStyle,
});
