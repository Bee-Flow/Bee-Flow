import { useState } from 'react';
import type { CoworkSpec } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkActivity from './CoworkActivity';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_WIDE, LINK_INLINE } from './coworkUi';

interface Props {
    clarification: NonNullable<CoworkSpec['clarification']>;
    onAnswer: (answer: string) => void;
    onCancel: () => void;
    useConversation?: boolean;
}

export default function CoworkBriefQuestion({ clarification, onAnswer, onCancel, useConversation }: Props) {
    const { t } = useTranslation();
    const [answer, setAnswer] = useState('');
    const label = t('cowork_home.confirm.your_answer', 'Your answer');
    return <CoworkActivity message={clarification.question} work={{ action: 'ask' }} tone="rest" testId="cowork-confirm">
        <div className="mx-auto grid w-full max-w-md gap-3">
            {clarification.options.length > 0 && <div className="flex flex-wrap justify-center gap-2">
                {clarification.options.map(option => <button type="button" className={BUTTON_SECONDARY} key={option} onClick={() => onAnswer(option)}>{option}</button>)}
            </div>}
            {!useConversation && <form className="flex items-center gap-2" onSubmit={event => {
                event.preventDefault();
                if (answer.trim()) onAnswer(answer.trim());
            }}>
                <input aria-label={label} placeholder={label} className={FIELD_WIDE} value={answer} maxLength={500} onChange={event => setAnswer(event.target.value)} />
                <button className={BUTTON_PRIMARY} disabled={!answer.trim()}>{t('cowork_home.examples.next', 'Continue')}</button>
            </form>}
            <button type="button" className={LINK_INLINE + ' justify-self-center'} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
        </div>
    </CoworkActivity>;
}
