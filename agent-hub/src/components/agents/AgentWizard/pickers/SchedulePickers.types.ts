import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { Schedule } from '../builderSplit/useAgentSchedules';
import type { EditorAgent } from '../builderSplit/editorTypes';

export interface SchedulesPickerProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    agent: { id?: string | null; };
    schedules: Schedule[];
    onClose: () => void;
    onCreate: () => void;
    onEdit: (r: Schedule) => void;
    onToggle: (r: Schedule) => Promise<void>;
    onRunNow: (r: Schedule) => Promise<void>;
    onDelete: (r: Schedule) => void;
}

export interface ScheduleModalProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    agent: EditorAgent;
    initialSchedule: Schedule | null;
    onClose: () => void;
    onSaved: () => Promise<void>;
}
