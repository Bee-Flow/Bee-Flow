import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { fieldLabelClass, hintTextClass, requiredChipClass } from '../formStyles';

interface Props {
    label: string;
    /** A plain sentence under the field on what it is for. */
    help: string;
    required?: boolean;
    children: ReactNode;
}

/** One setting of a step: its label, the control, and a sentence under it that always shows. */
export default function StepField({ label, help, required = false, children }: Props) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
                <span className={fieldLabelClass()}>{label}</span>
                {required && <span className={requiredChipClass()}>{t('automation_tables.field.required', 'Required')}</span>}
            </div>
            {children}
            <p className={hintTextClass()}>{help}</p>
        </div>
    );
}
