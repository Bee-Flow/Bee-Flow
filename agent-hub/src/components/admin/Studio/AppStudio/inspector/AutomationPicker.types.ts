import type { WiredAutomation } from './useEventWiring';
import type { FormFieldRef } from './appDefinition';

/** An automation as the list returns it, as far as this picker reads it. */
export interface PickerAutomation extends WiredAutomation {
    description?: string;
    isActive?: boolean;
    triggerType?: string;
}

export type AppRefProp = { appId: string; screenId: string; nodeId?: string; appName?: string; canOpen?: boolean } | null;

export interface AutomationPickerProps {
    open: boolean;
    onClose: () => void;
    onPick: (automation: PickerAutomation) => void;
    formFields?: FormFieldRef[];
    appRef?: AppRefProp;
}

export interface AutomationPickerBodyProps {
    onPick: (automation: PickerAutomation) => void;
    formFields: FormFieldRef[];
    appRef: AppRefProp;
}

export interface CreateAutomationRowProps {
    formFields: FormFieldRef[];
    appRef?: AppRefProp;
    onCreated: (automation: PickerAutomation) => void;
}
