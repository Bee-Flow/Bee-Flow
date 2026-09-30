/**
 * One conditional section: its title, its summary and when it applies — at
 * any depth, groups inside groups, as on the web (RuleEditor).
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, Text, TextField } from '@/shared/ui';

import { RuleEditor } from './RuleEditor';
import type { ContractParameter, ContractSection } from '../model/types';

export interface SectionSheetProps {
    section: ContractSection | null;
    parameters: ContractParameter[];
    onClose: () => void;
    onDone: (next: ContractSection) => void;
}

function SectionForm({ s, parameters, set }: { s: ContractSection; parameters: ContractParameter[]; set: (patch: Partial<ContractSection>) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.form}>
            <TextField label={t('mobile.studio_documents.section.title', 'Title')} value={s.title} onChangeText={(title) => set({ title })} />
            <TextField label={t('mobile.studio_documents.section.summary', 'Summary')} value={s.summary} multiline onChangeText={(summary) => set({ summary })} />
            <Text variant="label" weight="semibold" tone="tertiary">
                {t('mobile.studio_documents.section.applies', 'When it applies')}
            </Text>
            <RuleEditor value={s.condition} parameters={parameters} onChange={(condition) => set({ condition })} />
            {s.source ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.studio_documents.section.linked', 'Linked revision: {version}', { version: s.source.versionId.slice(0, 8) })}
                </Text>
            ) : null}
        </View>
    );
}

export function SectionSheet({ section, parameters, onClose, onDone }: SectionSheetProps) {
    const t = useTranslation();
    const [s, setS] = useState<ContractSection | null>(section);
    const [seen, setSeen] = useState(section);
    if (seen !== section) {
        setSeen(section);
        setS(section);
    }
    const set = (patch: Partial<ContractSection>) => setS((prev) => (prev ? { ...prev, ...patch } : prev));
    return (
        <Sheet
            visible={section !== null}
            onClose={onClose}
            title={s?.title || s?.id || ''}
            footer={s ? <Button label={t('mobile.studio_documents.done', 'Done')} onPress={() => onDone(s)} fullWidth size="lg" /> : null}
            tall
        >
            {s ? <SectionForm s={s} parameters={parameters} set={set} /> : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({ form: { gap: theme.spacing[3] } });
