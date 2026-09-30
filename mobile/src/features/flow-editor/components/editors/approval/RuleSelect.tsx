/**
 * An approval's decision rule — any one approver, all of them, or a quorum —
 * as the web's rule select (approvalStages.jsx), for a round and for a stage.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';

export function RuleSelect({ value, onChange, label, disabled }: { value: string; onChange: (rule: string) => void; label?: string; disabled: boolean }) {
    const t = useTranslation();
    return (
        <SelectField
            label={label}
            value={value}
            options={[
                { value: 'all', label: t('routines.builder.approval_rule_all', 'Everyone must approve') },
                { value: 'first', label: t('routines.builder.approval_rule_first', 'First to respond decides') },
                { value: 'quorum', label: t('routines.builder.approval_rule_quorum', 'At least N approvals') },
            ]}
            onChange={onChange}
            disabled={disabled}
        />
    );
}
