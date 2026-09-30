/**
 * The fields of a list parameter — the columns of an invoice's line items:
 * each with its key, label, type (never another list) and whether it is
 * required. The web edits them as nested parameter cards; a phone edits them
 * inline, one compact card per field.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Button, Text, TextField, ToggleRow } from '@/shared/ui';

import { makeEditorStyles } from './editorStyles';
import { TypePicker } from './ParamFields';
import type { ContractParameter } from '../model/types';
import { newParameter, removeAt, replaceAt, withType } from '../model/values';

export interface ListFieldsEditorProps {
    fields: ContractParameter[];
    onChange: (fields: ContractParameter[]) => void;
}

export function ListFieldsEditor({ fields, onChange }: ListFieldsEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    const update = (index: number, patch: Partial<ContractParameter>) =>
        onChange(replaceAt(fields, index, { ...(fields[index] as ContractParameter), ...patch }));
    return (
        <View style={styles.block}>
            <Text variant="label" weight="semibold" tone="tertiary">
                {t('mobile.studio_documents.param.list_fields', 'List fields')}
            </Text>
            {fields.map((field, index) => (
                <View key={index} style={styles.card}>
                    <TextField label={t('mobile.studio_documents.param.key', 'Parameter key')} value={field.key} autoCapitalize="none" autoCorrect={false} onChangeText={(key) => update(index, { key })} />
                    <TextField label={t('mobile.studio_documents.param.label', 'Label')} value={field.label} onChangeText={(label) => update(index, { label })} />
                    <TypePicker value={field.type} nested onChange={(type) => onChange(replaceAt(fields, index, withType(field, type)))} />
                    <ToggleRow label={t('mobile.studio_documents.param.required', 'Required when applicable')} value={field.required} onValueChange={(required) => update(index, { required })} gutter={false} />
                    <Button label={t('mobile.studio_documents.param.remove_field', 'Remove field')} onPress={() => onChange(removeAt(fields, index))} variant="ghost" size="sm" />
                </View>
            ))}
            <Button
                label={t('mobile.studio_documents.param.add_field', 'Add list field')}
                iconName="Plus"
                variant="secondary"
                onPress={() => onChange([...fields, newParameter()])}
            />
        </View>
    );
}
