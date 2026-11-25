/**
 * The task lists of the Cowork home (./CoworkHome.tsx): "Your tasks" and "Shared with you". One row per task, which
 * opens it as its page: its title and status pill, then when it runs (and its goal), and what comes next on the right
 * ("Next: Tomorrow, 09:00"). The status is the one vocabulary of ./coworkTaskStatus.ts; the words of the row are
 * ./coworkTaskRowModel.ts. Rows arrive one after another (STAGGER of ./coworkMotion.ts), a new task among them.
 */
import type { ReactNode } from 'react';
import CoworkStatusPill from './CoworkStatusPill';
import { STAGGER } from './coworkMotion';
import type { NeedCardData } from './coworkNeedsModel';
import { whenLine } from './coworkOverviewModel';
import { nextLine } from './coworkTaskRowModel';
import { taskStatus, type TaskStatus } from './coworkTaskStatus';
import { CARD, LIST_ROW } from './coworkUi';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkItem } from '@/api/cowork.types';
import type { CoworkHome } from '@/api/coworkHome';
import type { SharedItem } from '@/api/coworkShares';

interface RowProps {
    /** Its place in the list, for the order in which the rows arrive. */
    index: number;
    title: string;
    status: TaskStatus | null;
    /** The line under the title: when it runs, and its goal. */
    when: ReactNode;
    next: string;
    onOpen: () => void;
}

const ROW_META = 'max-sm:col-span-2 text-[13px] leading-5 text-[var(--text-tertiary)]';

function TaskRow({ index, title, status, when, next, onOpen }: RowProps) {
    return (
        <li className={`border-t first:border-t-0 border-[var(--border-subtle)] ${STAGGER(index)}`}>
            <button type="button" onClick={onOpen} data-testid="cowork-task-row" className={`${LIST_ROW} grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1`}>
                <span className="truncate font-semibold text-[var(--text-primary)]">{title}</span>
                {status ? <span className="justify-self-end"><CoworkStatusPill status={status} /></span> : <span />}
                <span className={`${ROW_META} min-w-0`}>{when}</span>
                {next && <span className={`${ROW_META} sm:text-right tabular-nums`}>{next}</span>}
            </button>
        </li>
    );
}

function TaskList({ children, testId }: { children: ReactNode; testId: string }) {
    return <ul className={`m-0 list-none p-0 ${CARD} overflow-hidden`} data-testid={testId}>{children}</ul>;
}

interface CoworkTaskRowsProps {
    items: readonly CoworkItem[];
    cards: readonly NeedCardData[];
    home: CoworkHome | undefined;
    /** The task Cowork is setting up and testing now. */
    testingId: string | null;
    onOpen: (itemId: string) => void;
}

/** "Your tasks". */
export default function CoworkTaskRows({ items, cards, home, testingId, onOpen }: CoworkTaskRowsProps) {
    const { t, locale } = useTranslation();
    return (
        <TaskList testId="cowork-tasks">
            {items.map((item, index) => {
                const status = taskStatus(item, cards, { testing: item.id === testingId, outcome: home?.outcomes?.[item.id] });
                const goal = home?.how?.[item.id]?.goal?.sentence;
                const when = (
                    <>
                        {whenLine(item, t)}
                        {goal && <> · <span className="text-[var(--text-secondary)]">{t('cowork_home.row.target', 'Target: {goal}', { goal })}</span></>}
                    </>
                );
                return <TaskRow key={item.id} index={index} title={item.title || t('cowork_home.untitled', 'Untitled task')} status={status} when={when} next={nextLine(item, status, t, locale || 'en')} onOpen={() => onOpen(item.id)} />;
            })}
        </TaskList>
    );
}

/** "Shared with you": colleagues' tasks, with whose they are; opened read only. */
export function CoworkSharedRows({ items, onOpen }: { items: readonly SharedItem[]; onOpen: (id: string) => void }) {
    const { t } = useTranslation();
    return (
        <TaskList testId="cowork-shared">
            {items.map((item, index) => {
                const status = taskStatus({ id: item.id, isActive: item.isActive, lastStatus: item.lastStatus, lastRunAt: item.lastRunAt, runCount: item.lastRunAt ? 1 : 0 });
                const role = item.role === 'approver'
                    ? t('cowork_home.shared.decides', 'From {owner} · you decide its questions', { owner: item.ownerName })
                    : t('cowork_home.shared.sees', 'From {owner} · you can see it', { owner: item.ownerName });
                return <TaskRow key={item.id} index={index} title={item.title || t('cowork_home.untitled', 'Untitled task')} status={status} when={role} next="" onOpen={() => onOpen(item.id)} />;
            })}
        </TaskList>
    );
}
