import React from 'react';
import { UserCog } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { readinessStamp, useReadiness } from '@/api/queries/automation/readiness';
import { useAiActCheck } from '@/api/queries/automation/aiActCheck';
import AiActAutoCard from './AiActAutoCard';
import { aiActVisible, canRecordAiAct } from './AiActSection';
import type { SettingsAutomation } from './settingsUi';
import { ReadinessChecklist, readinessItems } from './ReadinessChecklist';

export { agoText } from './ReadinessChecklist';

const PREFERENCES_PATH = '/app/settings/preferences';

/** In-app navigation, like the rest of the SPA: push the path, let the shell hear popstate. */
function openPreferences(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    window.history.pushState({}, '', PREFERENCES_PATH);
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function RailStatus({ saved, loading, failed }: { saved: boolean; loading: boolean; failed: boolean }) {
    const { t } = useTranslation();
    let text: string | null = null;
    if (!saved) text = t('automations.ready.unsaved', 'Save the automation first.');
    else if (loading) text = t('automations.ready.loading', 'Checking…');
    else if (failed) text = t('automations.ready.error', 'Could not check right now.');
    return text ? <p className="text-[var(--text-tertiary)]">{text}</p> : null;
}

/**
 * The right column of Settings (artboard 5b): the AI Act card while Bee is
 * checking or has a question, the "Ready to activate?" checklist from GET
 * /:id/readiness, and the note that "Map fields automatically" moved to the
 * profile.
 */
export default function ReadinessRail({ automation, onOpenSection, extrasClassName = 'contents' }: {
    automation: SettingsAutomation | null;
    onOpenSection?: (section: string) => void;
    /**
     * Classes for the parts beyond the checklist (the AI Act card and the
     * profile note). The Settings page hides them while the rail shares a
     * column with the table of contents.
     */
    extrasClassName?: string;
}) {
    const { t } = useTranslation();
    const id = automation?.id || null;
    // The automation's version, updatedAt and description are part of the key: a
    // save refetches the checklist (readinessStamp).
    const stamp = readinessStamp(automation);
    const readiness = useReadiness(id, stamp);
    const r = readiness.data;
    const showAiAct = !!id && aiActVisible(r);
    const check = useAiActCheck(showAiAct ? id : null, stamp);

    return (
        <div className="flex flex-col gap-3 text-xs text-[var(--text-primary)]" data-testid="readiness-rail">
            {showAiAct && (
                <div className={extrasClassName}>
                    <AiActAutoCard variant="rail" automationId={id as string} stamp={stamp} canEdit={canRecordAiAct(automation)} />
                </div>
            )}

            <div className="p-3.5 rounded-xl bg-[var(--bg-secondary)] flex flex-col gap-2">
                <h3 className="font-semibold">{t('automations.ready.title', 'Ready to activate?')}</h3>
                <RailStatus saved={!!id} loading={readiness.isLoading} failed={readiness.isError} />
                {r && <ReadinessChecklist items={readinessItems(r, t, check.data)} onOpenSection={onOpenSection} />}
            </div>

            <div className={extrasClassName}>
                <p className="flex gap-1.5 text-[var(--text-tertiary)] leading-4">
                    <UserCog className="w-[13px] h-[13px] shrink-0 mt-px" aria-hidden />
                    <span>
                        {t('automations.ready.automap_note', '"Map fields automatically" is a personal preference and now lives in your profile under')}{' '}
                        <a href={PREFERENCES_PATH} onClick={openPreferences} className="underline">{t('automations.ready.automap_link', 'Editor preferences')}</a>.
                    </span>
                </p>
            </div>
        </div>
    );
}
