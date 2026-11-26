import { useRef } from 'react';
import type { CoworkItem } from '@/api/cowork.types';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { whenLine } from './coworkOverviewModel';
import { BUTTON_PRIMARY, LINK_INLINE } from './coworkUi';

const words = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Only an explicit request about an existing task can change where Submit goes.
// Ordinary briefs with overlapping vocabulary may still show a quiet suggestion.
const EDIT_COMMAND = /^(?:(?:please|can you|could you)\s+)*(?:change|update|modify|adjust|edit|pause|resume|rename|reschedule|wijzig|verander|bewerk|pauzeer|hervat|hernoem|verplaats|pas\b.+\baan)\b/i;
const EDIT_REQUEST_NL = /^(?:wil je|kun je|kun jij|kan je|kan jij|zou je|ik wil)\b.*\b(?:aanpassen|wijzigen|veranderen|bewerken|pauzeren|hervatten|hernoemen|verplaatsen)\b/i;

function rankedMatches(items: CoworkItem[], message: string) {
    if (message.length > 2000 || message.trim().length < 4) return [];
    const queryWords = words(message);
    const query = new Set(queryWords);
    const phrase = ' ' + queryWords.join(' ') + ' ';
    return items.map(item => {
        const title = words(item.title);
        const named = title.length > 0 && phrase.includes(' ' + title.join(' ') + ' ');
        const overlap = title.filter(word => query.has(word) && word.length >= 6);
        return { item, named, score: named ? 2 + title.length : overlap.length / Math.max(1, title.length) };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score);
}

export function useExistingTaskAction(items: CoworkItem[], message: string, ask?: (id: string, message: string) => void) {
    const firstChoice = useRef<HTMLButtonElement>(null);
    const ranked = ask ? rankedMatches(items, message) : [];
    const named = ranked.filter(match => match.named);
    const editing = ranked.length > 0 && (EDIT_COMMAND.test(message.trim()) || EDIT_REQUEST_NL.test(message.trim()));
    const matches = editing && named.length ? named.map(match => match.item) : ranked.slice(0, 3).map(match => match.item);
    const direct = editing && named.length === 1 ? named[0].item : null;
    const open = (task: CoworkItem) => ask?.(task.id, message.trim());
    const submit = () => direct ? open(direct) : firstChoice.current?.focus();
    return { matches, editing, direct, firstChoice, open, submit };
}

type ExistingAction = ReturnType<typeof useExistingTaskAction>;

export function choiceDetail(task: CoworkItem, matches: CoworkItem[], t: TranslateFn) {
    const sameName = matches.filter(other => words(other.title).join(' ') === words(task.title).join(' '));
    if (sameName.length < 2) return '';
    const schedule = whenLine(task, t);
    const peers = sameName.filter(other => whenLine(other, t) === schedule);
    if (peers.length === 1) return schedule;
    const excerpt = (item: CoworkItem) => item.prompt?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
    const preview = excerpt(task);
    if (preview && peers.every(other => other.id === task.id || excerpt(other) !== preview)) return preview;
    const suffix = task.id.slice(-6);
    const id = peers.some(other => other.id !== task.id && other.id.endsWith(suffix)) ? task.id : suffix;
    return [preview, t('cowork_home.existing.reference', 'Task {id}', { id })].filter(Boolean).join(' · ');
}

export function ExistingSubmit({ action }: { action: ExistingAction }) {
    const { t } = useTranslation();
    return <button type="submit" className={BUTTON_PRIMARY}>{action.direct
        ? t('cowork_home.existing.ask_task', 'Ask Bee about {title}', { title: action.direct.title })
        : t('cowork_home.existing.choose', 'Choose a task')}</button>;
}

export default function CoworkExistingTasks({ action }: { action: ExistingAction }) {
    const { t } = useTranslation();
    if (!action.matches.length || action.direct) return null;
    return <div className="flex flex-wrap items-center gap-2 pt-2">
        <span className="text-[13px] text-[var(--text-secondary)]">{t('cowork_home.existing.ask', 'Ask Bee about an existing task')}</span>
        {action.matches.map((task, index) => {
            const detail = choiceDetail(task, action.matches, t);
            return <button ref={index === 0 ? action.firstChoice : undefined} key={task.id} type="button"
                className={LINK_INLINE + ' flex flex-col items-start text-left'} onClick={() => action.open(task)}>
                <span>{task.title}</span>{' '}{detail && <small className="text-[var(--text-secondary)]">{detail}</small>}
            </button>;
        })}
    </div>;
}
