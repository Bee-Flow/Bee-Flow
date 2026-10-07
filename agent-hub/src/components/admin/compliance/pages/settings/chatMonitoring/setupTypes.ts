import type { ChatMonitoringConfig } from '../../../data/useChatMonitoring';
import type { ChangeKind, ChatMonitoringForm } from './chatMonitoringForm';

/** What every section of the set-up form receives from ChatMonitoringSetup. */
export interface SetupSectionProps {
    form: ChatMonitoringForm;
    patch: (next: Partial<ChatMonitoringForm>) => void;
    config: ChatMonitoringConfig;
    change: ChangeKind;
    now: Date;
}

export const SECTION_CLASS = 'flex flex-col gap-2 border-t border-[var(--border-default)] pt-3';
export const SECTION_TITLE_CLASS = 'm-0 text-xs font-bold text-[var(--text-primary)]';
export const HINT_CLASS = 'm-0 text-[11px] leading-snug text-[var(--text-tertiary)]';
