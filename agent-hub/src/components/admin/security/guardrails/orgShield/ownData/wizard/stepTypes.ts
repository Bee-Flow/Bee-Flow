import type React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { CustomDataType } from '../ownDataModel';
import type { WizardAction, WizardState } from '../useTypeWizard';

/** What the wizard knows about the page around it. */
export interface WizardContext {
    orgId: string;
    /** Every type in the form, for placeholder uniqueness and the AI cap. */
    types: CustomDataType[];
    guardDown: boolean;
    canBlockExternal: boolean;
    upgradeUrl?: string;
}

export type ConfirmFn = (opts: {
    title: string; description?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean;
}) => Promise<boolean>;

/** The props every step receives. */
export interface StepProps {
    state: WizardState;
    dispatch: React.Dispatch<WizardAction>;
    ctx: WizardContext;
    t: TranslateFn;
}
