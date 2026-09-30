/**
 * The Art. 30 record for the table this playbook built — the compliance
 * phase's one write (the web's RegisterPanel). It opens filled in from what
 * is really there, except the legal basis, which it never picks: that is a
 * position somebody has to take. Registering also switches on the retention
 * clean-up, and records the review on the evidence chain.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, FilterPills, OptionRow, Text, TextField } from '@/shared/ui';

import { artRecord, artRecords, textOf } from '../model/artifacts';
import { basisOptions, dateColumns, registrationDefaults, retentionInput, writtenWords, type Registration } from '../model/complianceView';

type Loose = Record<string, unknown>;

const BASIS_WORDS: Readonly<Record<string, readonly [string, string]>> = {
    consent: ['mobile.playbooks.basis.consent', 'Consent'],
    contract: ['mobile.playbooks.basis.contract', 'Performance of a contract'],
    legal_obligation: ['mobile.playbooks.basis.legal_obligation', 'A legal obligation'],
    vital_interests: ['mobile.playbooks.basis.vital_interests', 'Vital interests'],
    public_task: ['mobile.playbooks.basis.public_task', 'A public task'],
    legitimate_interests: ['mobile.playbooks.basis.legitimate_interests', 'Legitimate interests'],
};

function basisWord(id: string, t: TranslateFn): string {
    const w = BASIS_WORDS[id];
    return w ? t(w[0], w[1]) : id;
}

function Registered({ registered, refused }: { registered: Loose; refused: string | null }) {
    const t = useTranslation();
    const lines = writtenWords(registered, t);
    if (refused) {
        const head = t('mobile.playbooks.compliance.registered_partly', 'Not everything was registered: {reason}', { reason: refused });
        return <Banner tone="error">{[head, ...lines].join('\n')}</Banner>;
    }
    return (
        <Banner tone="success">
            {[t('playbooks.compliance.registered', 'Registered. It is in the Compliance Center now.'), ...lines].join('\n')}
        </Banner>
    );
}

export function RegisterPanel({
    facts,
    registered,
    onRegister,
    busy,
    error,
    refused,
}: {
    facts: Loose;
    registered: Loose | null;
    onRegister: (reg: Registration) => void;
    busy: boolean;
    error: unknown;
    /** The route's `failed` list, read by `failedLine`: a 200 that still refused something. */
    refused: string | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const table = artRecord(facts, 'table');
    const [reg, setReg] = useState<Registration>(() => registrationDefaults(facts));
    const set = (patch: Partial<Registration>) => setReg((r) => ({ ...r, ...patch }));
    if (registered) return <Registered registered={registered} refused={refused} />;
    const dates = dateColumns(table, t);
    const columns = artRecords(table, 'columns');
    return (
        <View style={styles.panel} testID="playbook-register">
            <Text variant="subheading">{t('playbooks.compliance.register_title', 'Record this processing')}</Text>
            <Text variant="caption" tone="secondary">
                {t('playbooks.compliance.register_intro', 'This is the Art. 30 record for "{table}". Registering also switches on the retention clean-up.', { table: textOf(table, 'name') })}
            </Text>
            <Text variant="label" tone="secondary">{t('playbooks.compliance.legal_basis', 'Legal basis')}</Text>
            {!reg.lawfulBasis ? (
                <Text variant="caption" tone="warning">
                    {t('playbooks.compliance.basis_open', 'No legal basis chosen yet. Nothing here picks one for you — Art. 6 is a judgement about why you may hold this data, and a pre-filled answer would be us making it. The record stays incomplete until you choose.')}
                </Text>
            ) : null}
            {basisOptions(facts).map((b) => (
                <OptionRow
                    key={b.id}
                    label={basisWord(b.id, t)}
                    description={b.configured ? t('playbooks.compliance.basis_configured', 'used by your organisation') : undefined}
                    selected={reg.lawfulBasis === b.id}
                    onPress={() => set({ lawfulBasis: b.id })}
                    testID={`playbook-basis-${b.id}`}
                />
            ))}
            <TextField label={t('playbooks.compliance.retention', 'Keep for (days)')} value={reg.retentionDays} onChangeText={(retentionDays) => set({ retentionDays: retentionInput(retentionDays) })} keyboardType="number-pad" maxLength={4} />
            <Text variant="label" tone="secondary">{t('playbooks.compliance.retention_field', 'Counted from')}</Text>
            <FilterPills scroll value={reg.retentionField} onChange={(retentionField) => set({ retentionField })} options={dates.map((d) => ({ value: d.key, label: d.name }))} />
            {columns.length ? (
                <>
                    <Text variant="label" tone="secondary">{t('playbooks.compliance.subject_column', 'Which column names the person')}</Text>
                    <FilterPills scroll value={reg.subjectColumn} onChange={(subjectColumn) => set({ subjectColumn })} options={columns.map((c) => ({ value: textOf(c, 'key'), label: textOf(c, 'name') || textOf(c, 'key') }))} />
                </>
            ) : null}
            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}
            {refused ? <Banner tone="error">{refused}</Banner> : null}
            <Button label={t('playbooks.compliance.register_go', 'Register it')} loading={busy} onPress={() => onRegister(reg)} testID="playbook-register-go" />
            <Text variant="label" tone="tertiary">{t('playbooks.compliance.register_note', 'Nothing else on this screen writes anything.')}</Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    panel: {
        gap: theme.spacing[2],
        paddingTop: theme.spacing[3],
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderDefault,
    },
});
