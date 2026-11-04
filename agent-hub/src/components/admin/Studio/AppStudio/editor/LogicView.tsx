import React, { useState } from 'react';
import type { ReactNode } from 'react';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import RunsView from '../runs/RunsView';

type Tab = 'logic' | 'runs';

/**
 * The Logic view with its two tabs: the logic table (LogicaTab, unchanged) and the app's Runs
 * (the run log). "Open the action in Logic" from a run switches back.
 */
export default function LogicView({ appId, actionIds, logic }: { appId: string; actionIds: string[]; logic: ReactNode }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<Tab>('logic');
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="px-4 pt-3">
                <SegmentedControl<Tab>
                    value={tab}
                    onChange={setTab}
                    size="sm"
                    ariaLabel={t('studio_apps_runs.tabs.label', 'Logic or runs')}
                    options={[
                        { value: 'logic', label: t('studio_apps_runs.tabs.logic', 'Logic') },
                        { value: 'runs', label: t('studio_apps_runs.tabs.runs', 'Runs') },
                    ]}
                />
            </div>
            {tab === 'logic' ? logic : <RunsView appId={appId} actionIds={actionIds} onOpenLogic={() => setTab('logic')} />}
        </div>
    );
}
