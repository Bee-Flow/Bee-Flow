import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { readinessStamp, useReadiness, type Readiness } from '../../../../api/queries/automation/readiness';
import AiActAutoCard from './AiActAutoCard';
import { SectionHeading, type SaveFn, type SettingsAutomation } from './settingsUi';

/**
 * Whether the routine shows an AI Act check at all: only when the server
 * says one is required (the routine's organisation has the compliance hub).
 * `not_required` hides the card, the section and the checklist row.
 */
export function aiActVisible(r: Readiness | undefined): boolean {
    return !!r && r.aiAct.required && r.aiAct.status !== 'not_required';
}

/** The check still has to be done (or redone) before Activate. */
export function aiActOpen(r: Readiness | undefined): boolean {
    return aiActVisible(r) && (['missing', 'expired', 'outdated'] as string[]).includes((r as Readiness).aiAct.status);
}

/** Owners and editors answer and change the check; viewers only read it. */
export function canRecordAiAct(a: SettingsAutomation | null | undefined): boolean {
    const role = a?.myRole;
    return role == null || role === 'owner' || role === 'edit';
}

/**
 * Settings › AI Act check. Bee checks the routine by itself and asks only
 * what it cannot tell (AiActAutoCard). Hidden when the routine needs no check
 * (no compliance hub in the plan, or no organisation).
 */
export default function AiActSection({ automation }: { automation: SettingsAutomation | null; onSave?: SaveFn }) {
    const { t } = useTranslation();
    const id = automation?.id || null;
    const stamp = readinessStamp(automation);
    const readiness = useReadiness(id, stamp);
    if (!id || !aiActVisible(readiness.data)) return null;
    return (
        <div className="flex flex-col gap-2.5 text-xs" data-testid="aiact-section">
            <SectionHeading>{t('routines.aiact.title', 'AI Act check')}</SectionHeading>
            <AiActAutoCard automationId={id} stamp={stamp} canEdit={canRecordAiAct(automation)} />
        </div>
    );
}
