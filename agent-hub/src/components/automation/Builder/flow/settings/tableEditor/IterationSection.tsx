import type { ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import AccordionSection from '../../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import { FormRow } from '../formPrimitives';

// Untyped JS component; its props are checked there.
const ForEach = ForEachSection as unknown as ComponentType<Record<string, unknown>>;
const Retry = RetrySection as unknown as ComponentType<Record<string, unknown>>;
const retrySet = retryIsSet as unknown as (draft: Record<string, unknown>) => boolean;

interface Props {
    stepType: 'table' | 'read_table';
    draft: Record<string, unknown>;
    set: (key: string, value: unknown) => void;
    groups?: unknown[];
    onFocusField?: unknown;
    errorSections?: Set<string>;
}

/** Iteration and Try again, for a step that already has an Advanced section. */
export function IterationRow({ draft, set, groups, onFocusField }: Omit<Props, 'stepType' | 'errorSections'>) {
    const { t } = useTranslation();
    return (
        <FormRow label={t('automation_tables.iteration.label', 'Iteration')} hint={t('automation_tables.iteration.hint', 'Off by default: the step runs once. Turn on to run it once for every item of a list from an earlier step.')}>
            <ForEach draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
        </FormRow>
    );
}

/** Try again when the step fails. */
export function RetryRow({ draft, set }: Pick<Props, 'draft' | 'set'>) {
    return <Retry draft={draft} set={set} />;
}

/** "Run once per item of a list", the same Iteration setting the other steps offer. */
export default function IterationSection({ stepType, draft, set, groups, onFocusField, errorSections }: Props) {
    const { t } = useTranslation();
    return (
        <AccordionSection stepType={stepType} sectionKey="advanced" title={t('automation_tables.iteration.title', 'Advanced')} forceOpen={!!errorSections?.has('advanced')} hasContent={!!draft.forEach || retrySet(draft)}>
            <IterationRow draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
            <RetryRow draft={draft} set={set} />
        </AccordionSection>
    );
}
