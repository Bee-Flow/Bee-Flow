/**
 * How many approvers a quorum needs, from two up to the seats there are
 * (approvalStages.jsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';

import { quorumValue } from './approvalModel';

export function QuorumSelect({ value, seats, onChange, disabled }: { value: unknown; seats: number; onChange: (n: number) => void; disabled: boolean }) {
    const t = useTranslation();
    const options = Array.from({ length: seats }, (_, i) => i + 1).map((n) => ({ value: String(n), label: t('routines.builder.approval_quorum_option', '{n} of {m}', { n: String(n), m: String(seats) }) }));
    return <SelectField value={String(quorumValue(value, seats))} options={options} onChange={(v) => onChange(Number(v))} disabled={disabled} />;
}
