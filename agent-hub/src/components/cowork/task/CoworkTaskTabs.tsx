import type { ReactNode } from 'react';
import Tabs from '@/components/shared/Tabs';
import { useTranslation } from '@/hooks/useTranslation';

export type TaskTab = 'result' | 'settings' | 'steps' | 'people' | 'history';

interface CoworkTaskTabsProps {
    idPrefix: string;
    value: TaskTab;
    onChange: (tab: TaskTab) => void;
    panels: Partial<Record<TaskTab, ReactNode>>;
}

export default function CoworkTaskTabs({ idPrefix, value, onChange, panels }: CoworkTaskTabsProps) {
    const { t } = useTranslation();
    const tabs: { id: TaskTab; label: string }[] = [
        { id: 'result', label: t('cowork_task.tabs.result', 'Result') },
        { id: 'settings', label: t('cowork_task.set.heading', 'Settings') },
        { id: 'steps', label: t('cowork_task.steps.heading', 'Steps') },
        { id: 'people', label: t('cowork_task.people.heading', 'People') },
        { id: 'history', label: t('cowork_task.history.heading', 'History') },
    ];
    const items = tabs.filter(({ id }) => panels[id] !== undefined);
    return (
        <>
            <Tabs idPrefix={idPrefix} value={value} onChange={onChange} items={items}
                ariaLabel={t('cowork_task.tabs.label', 'Task details')} size="sm" className="flex-wrap sm:flex-nowrap" />
            {items.map(({ id }) => (
                <div key={id} role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`}
                    hidden={id !== value} tabIndex={0} className={id === value ? 'flex min-w-0 flex-col gap-6' : 'hidden'}>
                    {panels[id]}
                </div>
            ))}
        </>
    );
}
