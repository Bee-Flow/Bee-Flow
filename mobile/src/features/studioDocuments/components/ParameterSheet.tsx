/**
 * One parameter of the document's contract, edited in a sheet — the web's
 * Parameter card: key, label, type, required, the short explanation, the
 * instructions for people and AI, choices, an example, a default, and for a
 * list the fields of each row.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, TextField, ToggleRow } from '@/shared/ui';

import { ListFieldsEditor } from './ListFieldsEditor';
import { TypePicker, TypedValueField, YesNoPicker } from './ParamFields';
import type { ContractParameter } from '../model/types';
import { inputText, withType } from '../model/values';

export interface ParameterSheetProps {
    parameter: ContractParameter | null;
    onClose: () => void;
    onDone: (next: ContractParameter) => void;
    onDelete: () => void;
}

function DefaultField({ p, set }: { p: ContractParameter; set: (patch: Partial<ContractParameter>) => void }) {
    const t = useTranslation();
    const label = t('mobile.studio_documents.param.default', 'Default (optional)');
    if (p.type === 'list') return null;
    if (p.type === 'boolean') return <YesNoPicker label={label} value={p.default} onChange={(value) => set({ default: value })} />;
    return <TypedValueField key={p.type} type={p.type} label={label} value={p.default} onChange={(value) => set({ default: value })} />;
}

function ParameterForm({ p, set }: { p: ContractParameter; set: (patch: Partial<ContractParameter>) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.form}>
            <TextField label={t('mobile.studio_documents.param.key', 'Parameter key')} value={p.key} autoCapitalize="none" autoCorrect={false} onChangeText={(key) => set({ key })} />
            <TextField label={t('mobile.studio_documents.param.label', 'Label')} value={p.label} onChangeText={(label) => set({ label })} />
            <TypePicker value={p.type} onChange={(type) => set(withType(p, type))} />
            <ToggleRow label={t('mobile.studio_documents.param.required', 'Required when applicable')} value={p.required} onValueChange={(required) => set({ required })} gutter={false} />
            <TextField label={t('mobile.studio_documents.param.summary', 'Short explanation')} value={p.summary} onChangeText={(summary) => set({ summary })} />
            <TextField
                label={t('mobile.studio_documents.param.instructions', 'Instructions for people and AI')}
                value={p.instructions}
                multiline
                onChangeText={(instructions) => set({ instructions })}
            />
            {p.type === 'choice' ? (
                <TextField
                    label={t('mobile.studio_documents.param.options', 'Choices (one per line)')}
                    value={(p.options ?? []).join('\n')}
                    multiline
                    onChangeText={(text) => set({ options: text.split('\n') })}
                />
            ) : null}
            <TextField label={t('mobile.studio_documents.param.example', 'Example')} value={inputText(p.example)} onChangeText={(example) => set({ example })} />
            <DefaultField p={p} set={set} />
            {p.type === 'list' ? <ListFieldsEditor fields={p.fields ?? []} onChange={(fields) => set({ fields })} /> : null}
        </View>
    );
}

/** The sheet keeps its own copy; "Done" hands it back, closing drops it. */
export function ParameterSheet({ parameter, onClose, onDone, onDelete }: ParameterSheetProps) {
    const t = useTranslation();
    const [p, setP] = useState<ContractParameter | null>(parameter);
    const [seen, setSeen] = useState(parameter);
    if (seen !== parameter) {
        setSeen(parameter);
        setP(parameter);
    }
    const set = (patch: Partial<ContractParameter>) => setP((prev) => (prev ? { ...prev, ...patch } : prev));
    const footer = p ? (
        <>
            <Button label={t('mobile.studio_documents.done', 'Done')} onPress={() => onDone(p)} fullWidth size="lg" />
            <Button label={t('mobile.studio_documents.param.remove', 'Remove parameter')} onPress={onDelete} variant="danger" fullWidth />
        </>
    ) : null;
    return (
        <Sheet
            visible={parameter !== null}
            onClose={onClose}
            title={p?.label || p?.key || t('mobile.studio_documents.param.new', 'New parameter')}
            footer={footer}
            tall
        >
            {p ? <ParameterForm p={p} set={set} /> : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({ form: { gap: theme.spacing[3] } });
