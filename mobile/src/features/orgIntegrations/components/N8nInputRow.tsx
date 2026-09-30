/**
 * One input parameter of an n8n workflow (N8nSection.jsx "Input Parameters"):
 * its name, its type and what it means, all read by the AI that fills it in.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Icon, IconButton, Segmented, TextField } from '@/shared/ui';

import { N8N_INPUT_TYPES, type N8nInput } from '../model/n8nTypes';

const styles = StyleSheet.create({
    card: { gap: 8 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { flex: 1 },
});

export function N8nInputRow({
    input,
    index,
    onChange,
    onRemove,
}: {
    input: N8nInput;
    index: number;
    onChange: (patch: Partial<N8nInput>) => void;
    onRemove: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <Card style={styles.card}>
            <View style={styles.head}>
                <TextField
                    testID={`n8n-input-${index}-name`}
                    containerStyle={styles.name}
                    placeholder={t('mobile.orgIntegrations.n8n_input_name', 'name')}
                    autoCapitalize="none"
                    value={input.name}
                    onChangeText={(name) => onChange({ name })}
                />
                <IconButton
                    icon={<Icon name="X" size={18} color={theme.colors.textTertiary} />}
                    accessibilityLabel={t('mobile.orgIntegrations.n8n_input_remove', 'Remove input')}
                    onPress={onRemove}
                />
            </View>
            <Segmented
                options={N8N_INPUT_TYPES.map((type) => ({ value: type, label: type }))}
                value={input.type}
                onChange={(type) => onChange({ type })}
                fullWidth
            />
            <TextField
                testID={`n8n-input-${index}-description`}
                placeholder={t('mobile.orgIntegrations.n8n_input_description', 'description')}
                value={input.description}
                onChangeText={(description) => onChange({ description })}
            />
        </Card>
    );
}
