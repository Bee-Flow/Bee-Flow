import { useState } from 'react';
import type { CoworkReply, CoworkSettingChoice } from '@/api/coworkProposals';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { OrbView } from './CoworkTaskOrb';

export default function useOrbDestinations(select: (view: OrbView) => void, openTask: (id: string, shared?: boolean) => void, t: TranslateFn) {
    const [choices, setChoices] = useState<CoworkSettingChoice[]>([]);
    const [tasks, setTasks] = useState<NonNullable<CoworkReply['tasks']>>([]);
    const clear = () => { setChoices([]); setTasks([]); };
    const receive = (answer: CoworkReply) => {
        if (answer.tasks) {
            const target = answer.tasks.find(task => task.id === answer.switchTo);
            if (target) openTask(target.id, target.shared);
            else {
                select('overview');
                setTasks(answer.tasks);
            }
            return answer.tasks.length ? t('cowork_task.orb.choose_work', 'Which task would you like to open?')
                : t('cowork_task.orb.no_work', 'I couldn’t find another matching task. Try a different name.');
        }
        if (answer.choices?.length) {
            setChoices(answer.choices);
            select('overview');
        }
        return answer.answer;
    };
    const pickChoice = (choice: CoworkSettingChoice) => { clear(); select(choice); };
    return {choices, tasks, receive, clear, pickChoice, openTask};
}
