import { useMemo } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { OnFocusField } from '../../../mapping/focusField.types';
import AccordionSection from '../../AccordionSection';
import FieldHint from '../../FieldHint';
import { hintTextClass } from '../formPrimitives';
import type { FormRecord } from '../formState/types';
import { AddCheckMenu } from './AddCheckMenu';
import { AllowedBody, ItemsBody, NumbersBody, ScriptBody } from './checkBodies';
import { CheckCard } from './CheckCard';
import {
    addCard, canShowList, cardsOf, kindAvailable, removeCard, setShown, updateCard, type Card,
} from './checkLists';
import { FallbackEditor } from './FallbackEditor';
import {
    outputFieldPaths, reliabilityIsSet, reliabilityProblems,
    type Check, type CheckKind, type EnumFrom, type Fallback, type FieldPathOption,
} from './reliabilityModel';

interface Props {
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
    stepIssues?: { errors?: { path?: unknown; message?: unknown }[] } | null;
}

function useCardTitles(): Record<CheckKind, { title: string; hint: string }> {
    const { t } = useTranslation();
    return {
        allowedFrom: {
            title: t('ai_step_checks.kind_allowed', 'Must be one of the values in a list'),
            hint: t('ai_step_checks.kind_allowed_hint', 'For a field that has to be a known value, such as a category, a name or a code from your own list. Anything outside the list is caught.'),
        },
        numbersFrom: {
            title: t('ai_step_checks.kind_numbers', 'Numbers must come from the data'),
            hint: t('ai_step_checks.kind_numbers_hint', 'For a summary or a report: every number the AI writes must also be in the data it was given. A made-up figure is caught.'),
        },
        script: {
            title: t('ai_step_checks.kind_script', 'Written in one alphabet'),
            hint: t('ai_step_checks.kind_script_hint', 'For a translation or a reply that must stay in one writing system.'),
        },
        items: {
            title: t('ai_step_checks.kind_items', 'Number of items'),
            hint: t('ai_step_checks.kind_items_hint', 'For a list in the answer: at least, at most, or exactly as many as another list.'),
        },
    };
}

/** The form for one card, by the kind of its check. */
function CardBody({ card, fields, ariaBase, previewSample, onFocusField, enumFrom, checks, set }: {
    card: Card; fields: FieldPathOption[]; ariaBase: string; previewSample: unknown; onFocusField: OnFocusField | null;
    enumFrom: EnumFrom[]; checks: Check[]; set: (key: string, value: unknown) => void;
}) {
    const common = { fields, ariaBase, previewSample, onFocusField };
    const entry = card.entry;
    const onChange = (next: Check) => updateCard(card, next, enumFrom, checks, set);
    if (entry.kind === 'allowedFrom') {
        return (
            <AllowedBody
                {...common} entry={entry} onChange={onChange}
                shown={card.list === 'enumFrom'} onShownChange={(on) => setShown(card, on, enumFrom, checks, set)} canShow={canShowList(enumFrom)}
            />
        );
    }
    if (entry.kind === 'numbersFrom') return <NumbersBody {...common} entry={entry} onChange={onChange} />;
    if (entry.kind === 'script') return <ScriptBody {...common} entry={entry} onChange={onChange} />;
    return <ItemsBody {...common} entry={entry} onChange={onChange} />;
}

const asList = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : []);
/** The fallback is asked about once something is checked, or when one is already stored. */
const showsFallback = (draft: FormRecord, count: number) => count > 0 || draft.fallback?.kind === 'value';

/** What to do first, when nothing is checked yet. */
function EmptyNote({ hasFields }: { hasFields: boolean }) {
    const { t } = useTranslation();
    return (
        <p className={hintTextClass()}>
            {hasFields
                ? t('ai_step_checks.empty', 'Nothing is checked yet. Add a rule when an answer has to be a known value, use only numbers from the data, or have a certain size.')
                : t('ai_step_checks.no_fields', 'Add fields under Structured output first: a check looks at one field of the answer.')}
        </p>
    );
}

/** "Answer checks": rules the answer must pass, checked after the AI has replied. */
export function AnswerChecksSection({ draft, set, onFocusField = null, previewSample = null, errorSections = new Set<string>(), stepIssues = null }: Props) {
    const { t } = useTranslation();
    const titles = useCardTitles();
    const enumFrom = asList<EnumFrom>(draft.enumFrom);
    const checks = asList<Check>(draft.checks);
    const outputFields = asList<{ key: string }>(draft.outputFields);
    const fields = useMemo(() => outputFieldPaths(outputFields), [outputFields]);
    const problems = useMemo(() => reliabilityProblems(stepIssues), [stepIssues]);
    const cards = cardsOf(enumFrom, checks);
    const hasFields = fields.length > 0;

    return (
        <AccordionSection
            stepType="ai_step" sectionKey="checks" title={t('ai_step_checks.section_title', 'Answer checks')}
            defaultOpen={cards.length > 0} forceOpen={errorSections.has('checks')}
            hasContent={reliabilityIsSet(draft)}
            meta={<FieldHint title={t('ai_step_checks.section_about', 'About Answer checks')}>{t('ai_step_checks.section_hint', 'Rules the answer must pass. If it does not, the AI is asked once more with a note about what was wrong; if it still fails, the step stops or uses a fallback. Checks look at the finished answer and are never sent to the AI.')}</FieldHint>}
        >
            <div className="space-y-2">
                {cards.length === 0 && <EmptyNote hasFields={hasFields} />}
                {cards.map(card => (
                    <CheckCard
                        key={`${card.list}-${card.index}`}
                        title={titles[card.entry.kind].title}
                        hint={titles[card.entry.kind].hint}
                        problem={problems.get(`${card.list}:${card.index}`) ?? null}
                        onRemove={() => removeCard(card, enumFrom, checks, set)}
                    >
                        <CardBody card={card} fields={fields} ariaBase={titles[card.entry.kind].title} previewSample={previewSample} onFocusField={onFocusField} enumFrom={enumFrom} checks={checks} set={set} />
                    </CheckCard>
                ))}
                {(hasFields || cards.length > 0) && (
                    <AddCheckMenu
                        titles={titles}
                        available={(k) => kindAvailable(k, enumFrom, checks)}
                        onAdd={(k) => addCard(k, fields, enumFrom, checks, set)}
                    />
                )}
                {showsFallback(draft, cards.length) && (
                    <FallbackEditor
                        fallback={(draft.fallback ?? null) as Fallback | null}
                        outputFields={outputFields}
                        onChange={(next) => set('fallback', next)}
                        problem={problems.get('fallback') ?? null}
                        previewSample={previewSample}
                        onFocusField={onFocusField}
                    />
                )}
            </div>
        </AccordionSection>
    );
}
