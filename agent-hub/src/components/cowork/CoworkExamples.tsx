import { useId, useState } from 'react';
import { CalendarDays, FileInput, Mail, Table2 } from 'lucide-react';
import CoworkActivity from './CoworkActivity';
import { FIELD, LINK_BUTTON } from './coworkUi';
import { useReadableTables } from '@/api/coworkStart';
import type { TranslateFn } from '@/hooks/useTranslation';

function examples(t: TranslateFn) {
    const table = t('cowork_home.examples.table', 'Which table should Cowork use?');
    return [
        { Icon: CalendarDays, label: t('cowork_home.examples.meetings', 'Weekly Fireflies summary'), questions: [],
            sentence: t('cowork_home.examples.meetings_brief', 'Every Monday at 09:00, summarise last week’s Fireflies meetings with decisions and action items per meeting. Send the summary to me.') },
        { Icon: Mail, label: t('cowork_home.examples.mail', 'Draft supplier replies'), questions: [t('cowork_home.examples.mailbox', 'Which connected mail app should Cowork read?'), t('cowork_home.examples.supplier', 'Which supplier email address should it look for?')],
            sentence: t('cowork_home.examples.mail_brief', 'Every weekday at 09:00, check [1] for new messages from [2]. Prepare a draft reply for each message that still needs one and leave it for my review.') },
        { Icon: FileInput, label: t('cowork_home.examples.files', 'Register Nextcloud files'), questions: [t('cowork_home.examples.folder', 'Which Nextcloud folder should Cowork check?'), table],
            sentence: t('cowork_home.examples.files_brief', 'Every weekday at 09:00, check the Nextcloud folder [1]. Add the name and path of each new file to the Datatables table [2], skipping paths already registered.') },
        { Icon: Table2, label: t('cowork_home.examples.alert', 'Report exceptions in a table'), questions: [table, t('cowork_home.examples.rule', 'Which values should trigger a notification?')],
            sentence: t('cowork_home.examples.alert_brief', 'Every weekday at 09:00, check the Datatables table [1]. Notify me only when a row meets this condition: [2]. Include the matching rows.') },
    ];
}

export default function CoworkExamples({ selected, select, onPick, t }: { selected: number | null; select: (index: number | null) => void; onPick: (text: string) => void; t: TranslateFn }) {
    const [answers, setAnswers] = useState<string[]>([]);
    const [answer, setAnswer] = useState('');
    const options = examples(t);
    const current = selected === null ? null : options[selected];
    const question = current?.questions[answers.length];
    const tableQuestion = (selected === 2 && answers.length === 1) || (selected === 3 && answers.length === 0);
    const tables = useReadableTables(tableQuestion);
    const suggestionsId = useId();
    const choose = (i: number) => {
        setAnswers([]);
        setAnswer('');
        select(options[i].questions.length ? i : null);
        if (!options[i].questions.length) onPick(options[i].sentence);
    };
    const next = () => {
        if (!current || !answer.trim()) return;
        const filled = [...answers, answer.trim()];
        if (filled.length === current.questions.length) {
            onPick(current.sentence.replace(/\[(\d)\]/g, (_, n: string) => filled[Number(n) - 1]));
            select(null);
        }
        setAnswers(filled);
        setAnswer('');
    };
    if (question) return <CoworkActivity message={question} tone="rest" work={{ action: 'ask' }}>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); next(); }}>
            <label className="flex flex-col gap-1"><span className="sr-only">{question}</span><input type={selected === 1 && answers.length === 1 ? 'email' : 'text'} list={tableQuestion ? suggestionsId : undefined} className={FIELD} maxLength={200} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>
            {tableQuestion && <datalist id={suggestionsId}>{tables.data?.map((table) => <option key={table.id} value={table.name || table.id} />)}</datalist>}
            <button type="button" className={LINK_BUTTON} onClick={() => select(null)}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
            <button className={LINK_BUTTON} disabled={!answer.trim()}>{t('cowork_home.examples.next', 'Continue')}</button>
        </form>
    </CoworkActivity>;
    return <div className="flex flex-col gap-2">
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {options.map(({ label, Icon }, i) => (
                <button key={label} type="button" onClick={() => choose(i)}
                    className="flex min-h-9 pointer-coarse:min-h-11 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                    <Icon aria-hidden="true" size={16} className="shrink-0 text-[var(--type-ai)]" />
                    {label}
                </button>
            ))}
        </div>

    </div>;
}
