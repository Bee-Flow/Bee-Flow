/**
 * The assistant's work modes for apps: the list the picker offers, what each
 * means for the request (`workMode` + the derived `planMode`), and the
 * per-user preference. The automations assistant has its own list; the picker
 * and the Alt+M shortcut are shared.
 */
import { Hammer, ListChecks, MessageCircleQuestion, MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WorkMode } from '@/components/automation/Builder/chat/WorkModePicker';
import scopedStorage from '@/utils/scopedStorage';

/** i18n prefix of the mode words (`<prefix>.<key>` and `<prefix>.<key>_hint`). */
export const APP_MODE_KEY_PREFIX = 'app_studio.builder.mode';

export const APP_WORK_MODES: WorkMode[] = [
    { id: 'describe', Icon: MessageSquareText, key: 'describe', label: 'Describe it', description: 'Tell me what the app should do, in your own words. I ask a few questions, write a plan, and build it after your OK.' },
    { id: 'discuss', Icon: MessageCircleQuestion, key: 'discuss', label: 'Just advise', description: 'Answers and gives advice. Leaves the app as it is.' },
    { id: 'plan', Icon: ListChecks, key: 'plan', label: 'Ask, plan, then build', description: 'Asks a few questions, writes a plan in plain words, and builds after your OK.' },
    { id: 'build', Icon: Hammer, key: 'build', label: 'Change it right away', description: 'Makes the changes straight away. You can undo them.' },
];

const DEFAULT_APP_WORK_MODE = 'build';
const MODE_KEY = 'appBuilderWorkMode';
const PLAN_LARGE_KEY = 'appBuilderPlanLarge';

export type PlanMode = 'auto' | 'always' | 'never';

/** The plan-first setting that goes with a work mode (the request contract). */
export function planModeFor(workMode: string, alwaysPlanLarge: boolean): PlanMode {
    if (workMode === 'describe' || workMode === 'plan') return 'always';
    if (workMode === 'discuss') return 'never';
    return alwaysPlanLarge ? 'auto' : 'never';
}

/** The `workMode` a plan approval carries: everyday words stay everyday words. */
export function approvalWorkMode(workMode: string): 'describe' | 'plan' {
    return workMode === 'describe' ? 'describe' : 'plan';
}

function readMode(): string {
    const saved = scopedStorage.getItem(MODE_KEY);
    return APP_WORK_MODES.some((m) => m.id === saved) ? (saved as string) : DEFAULT_APP_WORK_MODE;
}

/** The mode and the "check with me for big changes" box, kept per user. */
export function useAppWorkModePrefs() {
    const [workMode, setWorkMode] = useState<string>(readMode);
    const [alwaysPlanLarge, setAlwaysPlanLarge] = useState<boolean>(() => scopedStorage.getItem(PLAN_LARGE_KEY) !== 'false');
    useEffect(() => { scopedStorage.setItem(MODE_KEY, workMode); }, [workMode]);
    useEffect(() => { scopedStorage.setItem(PLAN_LARGE_KEY, String(alwaysPlanLarge)); }, [alwaysPlanLarge]);
    return { workMode, setWorkMode, alwaysPlanLarge, setAlwaysPlanLarge };
}
