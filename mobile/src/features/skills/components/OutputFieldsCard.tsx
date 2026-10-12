/**
 * "Delivers" — the fields an automation takes from this skill (the web's
 * OutputFieldsCard). Each field is read back in the words an automation uses
 * when it binds it. A field can be switched between the four scalar kinds or
 * removed from its row; a table, list or group built on the web keeps its
 * exact shape here, because only the field being changed is rewritten
 * (model/outputFields).
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Button, Card, ListRow, Section, Segmented, Text, TextField, type ActionMenuItem } from '@/shared/ui';

import {
    addOutputField,
    EDITABLE_KINDS,
    FIELD_KEY,
    KIND_WORD,
    outputFieldsOf,
    removeOutputField,
    setOutputFieldKind,
    type EditableKind,
    type OutputField,
} from '../model/outputFields';
import type { OutputSchema } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        add: { gap: theme.spacing.sm },
    });

const kindWord = (t: TranslateFn, kind: keyof typeof KIND_WORD) => t(KIND_WORD[kind].key, KIND_WORD[kind].en);

function fieldMenu(t: TranslateFn, schema: OutputSchema | null, field: OutputField, onChange: (s: OutputSchema | null) => void): ActionMenuItem[] {
    return [
        ...EDITABLE_KINDS.map((kind) => ({
            id: kind,
            label: kindWord(t, kind),
            selected: field.kind === kind,
            onPress: () => onChange(setOutputFieldKind(schema, field.key, kind)),
        })),
        { id: 'remove', label: t('automations.generic_row.remove_field', 'Remove field'), icon: 'Trash2' as const, destructive: true, onPress: () => onChange(removeOutputField(schema, field.key)) },
    ];
}

function AddField({ schema, onChange }: { schema: OutputSchema | null; onChange: (s: OutputSchema | null) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [key, setKey] = useState('');
    const [kind, setKind] = useState<EditableKind>('text');
    const taken = outputFieldsOf(schema).some((f) => f.key === key.trim());
    const valid = FIELD_KEY.test(key.trim()) && !taken;
    return (
        <View style={styles.add}>
            <TextField
                label={t('automations.parse_json_fields.field_name', 'Field name')}
                value={key}
                onChangeText={setKey}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('mobile.skills.field_key_example', 'total_amount')}
                hint={t('mobile.skills.field_key_hint', 'Letters, digits and underscores.')}
            />
            <Segmented options={EDITABLE_KINDS.map((k) => ({ value: k, label: kindWord(t, k) }))} value={kind} onChange={setKind} />
            <Button
                variant="secondary"
                iconName="Plus"
                label={t('automations.ndv.extraction.add_field', 'Add field')}
                disabled={!valid}
                onPress={() => {
                    onChange(addOutputField(schema, key, kind));
                    setKey('');
                }}
            />
        </View>
    );
}

export function OutputFieldsCard({
    schema,
    readOnly,
    onChange,
}: {
    schema: OutputSchema | null;
    readOnly: boolean;
    onChange: (schema: OutputSchema | null) => void;
}) {
    const t = useTranslation();
    const [editing, setEditing] = useState<OutputField | null>(null);
    const fields = outputFieldsOf(schema);
    return (
        <Section title={t('skills_studio.output.title', 'Delivers')} subtitle={t('skills_studio.output.hint', 'fields an automation can use')}>
            <Card padded={false}>
                {fields.length === 0 ? (
                    <ListRow title={t('skills_studio.output.empty', 'No fields — this skill answers in its own words.')} />
                ) : null}
                {fields.map((field) => (
                    <ListRow
                        key={field.key}
                        title={field.key}
                        subtitle={[kindWord(t, field.kind), field.unit].filter(Boolean).join(' · ')}
                        onPress={readOnly ? undefined : () => setEditing(field)}
                    />
                ))}
            </Card>
            {fields.length > 0 ? (
                <Text variant="label" tone="tertiary">
                    {t('skills_studio.output.as_automation_sees', 'How an automation will see these')}
                </Text>
            ) : null}
            {readOnly ? null : <AddField schema={schema} onChange={onChange} />}
            <ActionMenu
                visible={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.key}
                items={editing ? fieldMenu(t, schema, editing, onChange) : []}
            />
        </Section>
    );
}
