/**
 * One row of AI Act › Systems in words — the web's PerAutomationTab.jsx: the
 * outcome pill, the attested date, the validity (a date, "does not expire",
 * or expired) and the row action (Open, or Reassess once lapsed). Pure.
 */

import type { TranslateFn } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { AiActAssessmentRow } from '../api';
import { OUTCOME_LABEL, OUTCOME_TONE, type ChipTone } from './complianceModel';

export interface SystemRowWords {
    icon: IconName;
    title: string;
    kind: string;
    outcome: { label: string; tone: ChipTone };
    line: string;
    action: string;
}

const day = (iso: string | null): string => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '—';
};

function validity(row: AiActAssessmentRow, t: TranslateFn): string {
    if (!row.current) return t('compliance.ladder_chip_expired', 'Expired');
    if (!row.expiresAt) return t('compliance.fw_pa_evergreen', 'does not expire');
    return `${t('compliance.fw_pa_col_expiry', 'Valid')} → ${day(row.expiresAt)}`;
}

export function systemRowWords(row: AiActAssessmentRow, t: TranslateFn): SystemRowWords {
    const label = row.outcome ? OUTCOME_LABEL[row.outcome] : null;
    return {
        icon: row.kind === 'agent' ? 'Bot' : 'Workflow',
        title: row.title || row.id,
        kind: t(`compliance.fw_pa_kind_${row.kind}`, row.kind),
        outcome: {
            label: label ? t(label.key, label.en) : '—',
            tone: row.outcome ? OUTCOME_TONE[row.outcome] : 'neutral',
        },
        line: `${t('compliance.fw_pa_col_attested', 'Attested')} ${day(row.attestedAt)} · ${validity(row, t)}`,
        action: row.current ? t('compliance.fw_pa_open', 'Open') : t('compliance.fw_pa_reassess', 'Reassess'),
    };
}
