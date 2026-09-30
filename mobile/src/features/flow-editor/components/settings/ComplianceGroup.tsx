/**
 * The routine's AI Act declaration — the web Settings tab's Compliance block
 * (ComplianceBlock.jsx): the saved outcome, the signals the checks see, and
 * "Assess…", which opens the three-question ladder (Art. 5, Art. 50,
 * Annex III) in a sheet; recording it stamps the declaration on the server.
 * Shown to those who may see compliance; hidden where the compliance routes
 * are not there. Assess waits for the saved assessment: its signals and
 * answers are what the ladder starts from.
 */

import React, { useState } from 'react';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useAiActAssessment } from '@/features/flow-editor/hooks';
import { Badge, Group, Icon, ListRow, NoteRow, SettingRow, Text } from '@/shared/ui';

import { AiActLadderSheet } from './AiActLadderSheet';
import { chipLabel, chipState, outcomeWords, signalsLine } from './complianceModel';

export function ComplianceGroup({ automationId }: { automationId: string }) {
    const t = useTranslation();
    const allowed = useHasPermission('admin_compliance');
    const query = useAiActAssessment(automationId, allowed);
    const [assessing, setAssessing] = useState(false);
    if (!allowed || query.data === null) return null;
    const assessment = query.data ?? null;
    const chip = chipState(assessment);
    const line = signalsLine(assessment, t);
    return (
        <>
            <Group title={t('compliance.ladder_block_title', 'Compliance')} footer={t('compliance.ladder_block_hint', 'Three questions — Art. 5, Art. 50, Annex III — decide whether the AI Act applies here. A declaration is stamped and expires after 12 months.')}>
                {query.isError ? (
                    <NoteRow>
                        <Text variant="caption" tone="error">
                            {t('compliance.ladder_block_read_failed', 'The saved assessment could not be read.')}
                        </Text>
                    </NoteRow>
                ) : (
                    <ListRow
                        title={outcomeWords(assessment, t) ?? t('compliance.ladder_chip_not_assessed', 'Not assessed')}
                        subtitle={line ?? undefined}
                        trailing={<Badge label={chipLabel(assessment, t)} tone={chip.tone} />}
                        testID="flow-compliance-chip"
                    />
                )}
                <SettingRow
                    label={t('compliance.ladder_assess', 'Assess…')}
                    icon={<Icon name="ClipboardCheck" size={18} />}
                    onPress={() => setAssessing(true)}
                    disabled={!assessment}
                    testID="flow-compliance-assess"
                />
            </Group>
            {assessing && assessment ? <AiActLadderSheet automationId={automationId} assessment={assessment} onClose={() => setAssessing(false)} /> : null}
        </>
    );
}
