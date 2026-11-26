/**
 * The Cowork home, one calm column, top to bottom:
 *
 *   1. the composer: "What should be done for you?", one confirmation card, then the visible set-up and test of the
 *      new task's steps (./CoworkHomeComposer.tsx), with "Start from a template" in it;
 *   2. the notices: the organisation's budget from 80%, read-only mode (./CoworkHomeNotices.tsx);
 *   3. Needs you: at most three cards (./CoworkNeedCard.tsx), the rest behind "Show N more";
 *   4. Your tasks: title, status, when, next run, goal (./CoworkTaskRows.tsx);
 *   5. Shared with you, only when there is something;
 *   6. Teamwork: one quiet row that is always there, also for someone who is on no desk yet.
 *
 * A task, Templates and Teamwork are pages of their own (./CoworkPage.tsx): this column only asks for them.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Users } from 'lucide-react';
import CoworkHomeComposer from './CoworkHomeComposer';
import CoworkHomeNotices from './CoworkHomeNotices';
import CoworkNeedCard from './CoworkNeedCard';
import { NeedsOverview, type TaskFocus } from './CoworkNeedFrame';
import CoworkTaskRows, { CoworkSharedRows } from './CoworkTaskRows';
import { ENTER, LEAVE, useLeave } from './coworkMotion';
import type { NeedCardData } from './coworkNeedsModel';
import { pageName, type CoworkSheetPanel } from './coworkSheetPanels';
import { ALERT, CARD, LINK_BUTTON, LIST_ROW, META } from './coworkUi';
import useCoworkList from './useCoworkList';
import useCoworkNeedCards from './useCoworkNeedCards';
import useTaskSetup, { type TaskToSetUp } from './useTaskSetup';
import { useCoworkHome, type CoworkHome as CoworkHomeData } from '@/api/coworkHome';
import { useMyDesks } from '@/api/coworkDesks';
import { useSharedWithMe } from '@/api/coworkShares';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { CoworkItem } from '@/api/cowork.types';

const NEEDS_SHOWN = 3;
const FLASH_MS = 5000;
const NO_ITEMS: CoworkItem[] = [];

interface NeedsSectionProps {
    cards: readonly NeedCardData[];
    onOpenTask: (itemId: string, focus?: TaskFocus) => void;
    onDone: (message: string) => void;
}

function NeedsSection({ cards, onOpenTask, onDone }: NeedsSectionProps) {
    const { t } = useTranslation();
    const [all, setAll] = useState(false);
    if (cards.length === 0) return null;
    const shown = all ? cards : cards.slice(0, NEEDS_SHOWN);
    return (
        <section aria-labelledby="cowork-needs-heading" className="flex flex-col gap-2" data-testid="cowork-needs">
            <h2 id="cowork-needs-heading" className="m-0 text-[16px] leading-6 font-semibold text-[var(--text-primary)]">{t('cowork_home.needs.heading', 'Needs you · {count}', { count: cards.length })}</h2>
            <div className={`${CARD} overflow-hidden divide-y divide-[var(--border-subtle)]`}>
                <NeedsOverview.Provider value>{shown.map((need) => <CoworkNeedCard key={need.key} need={need} onOpenTask={onOpenTask} onDone={onDone} />)}</NeedsOverview.Provider>
            </div>
            {cards.length > NEEDS_SHOWN && (
                <button type="button" className={`${LINK_BUTTON} self-start`} aria-expanded={all} onClick={() => setAll((v) => !v)}>
                    {all ? t('cowork_home.needs.fewer', 'Show fewer') : t('cowork_home.needs.more', 'Show {count} more', { count: cards.length - NEEDS_SHOWN })}
                </button>
            )}
        </section>
    );
}

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
    return (
        <section aria-labelledby={`cowork-${id}-heading`} className="flex flex-col gap-2">
            <h2 id={`cowork-${id}-heading`} className="m-0 text-[16px] leading-6 font-semibold text-[var(--text-primary)]">{heading}</h2>
            {children}
        </section>
    );
}

interface TasksSectionProps {
    list: ReturnType<typeof useCoworkList>;
    items: readonly CoworkItem[];
    cards: readonly NeedCardData[];
    home: CoworkHomeData | undefined;
    testingId: string | null;
    onOpen: (itemId: string) => void;
}

/** "Your tasks": the rows, the read's failure, or that there are none yet. */
function TasksSection({ list, items, cards, home, testingId, onOpen }: TasksSectionProps) {
    const { t } = useTranslation();
    return (
        <Section id="tasks" heading={t('cowork_home.tasks.heading', 'Your tasks')}>
            {list.error && <p role="alert" className={ALERT}>{errorMessage(list.error)}</p>}
            {items.length > 0 && <CoworkTaskRows items={items} cards={cards} home={home} testingId={testingId} onOpen={onOpen} />}
            {items.length === 0 && list.isSuccess && <p className={`m-0 ${META}`}>{t('cowork_home.tasks.empty', 'No tasks yet. Write one sentence above to start.')}</p>}
        </Section>
    );
}

/** Teamwork, always there: the desks the owner is on by name, or what it is for while they are on none. Opens the Teamwork page. */
function TeamworkEntry({ onOpen }: { onOpen: () => void }) {
    const { t, locale } = useTranslation();
    const desks = useMyDesks().data ?? [];
    const names = new Intl.ListFormat(locale || 'en', { style: 'long', type: 'conjunction' }).format(desks.map((desk) => desk.name));
    return (
        <Section id="teamwork" heading={pageName('teamwork', t)}>
            <button type="button" onClick={onOpen} data-testid="cowork-teamwork" className={`${CARD} ${LIST_ROW} flex items-center gap-3`}>
                <Users aria-hidden="true" size={16} className="flex-shrink-0 text-[var(--text-tertiary)]" />
                <span className="flex-1 min-w-0 flex flex-col">
                    <span className="font-medium text-[var(--text-primary)]">
                        {desks.length > 0
                            ? t('cowork_pages.home.teamwork_on', 'You work together in {names}', { names })
                            : t('cowork_pages.home.teamwork_none', 'Let your tasks work together with colleagues’ tasks')}
                    </span>
                    <span className={META}>
                        {desks.length > 0
                            ? t('cowork_pages.home.teamwork_on_sub', 'See who does what, or set up another.')
                            : t('cowork_pages.home.teamwork_none_sub', 'Nothing is set up yet. Everyone keeps their own task and their own apps.')}
                    </span>
                </span>
                <ChevronRight aria-hidden="true" size={16} className="flex-shrink-0 text-[var(--text-tertiary)]" />
            </button>
        </Section>
    );
}

interface Flash { text: string; on: boolean }

/** One sentence after an action, said for a few seconds; its words stay while it fades. */
function useFlash(): [Flash | null, (message: string) => void] {
    const [flash, setFlash] = useState<Flash | null>(null);
    useEffect(() => {
        if (!flash?.on) return undefined;
        const timer = setTimeout(() => setFlash((was) => (was ? { ...was, on: false } : was)), FLASH_MS);
        return () => clearTimeout(timer);
    }, [flash]);
    const say = useCallback((text: string) => setFlash({ text, on: true }), []);
    return [flash, say];
}

function FlashLine({ flash }: { flash: Flash | null }) {
    const { ref, mounted, leaving } = useLeave<HTMLParagraphElement>(!!flash?.on);
    if (!mounted || !flash) return null;
    return <p ref={ref} role="status" className={`m-0 ${META} ${leaving ? LEAVE : ENTER}`} data-testid="cowork-flash">{flash.text}</p>;
}

export interface CoworkHomeProps {
    guided?: boolean;
    onAskTask?: (id: string, message: string) => void;
    onOpenTask: (itemId: string, focus?: TaskFocus) => void;
    onOpenPanel: (panel: CoworkSheetPanel) => void;
    /** A sentence to put in the composer (a template's). */
    seed?: { text: string; n: number } | null;
}

export default function CoworkHome({ guided, onAskTask, onOpenTask, onOpenPanel, seed = null }: CoworkHomeProps) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const list = useCoworkList();
    const items = list.data?.items ?? NO_ITEMS;
    const maxItems = list.data?.maxItems ?? 10;
    const home = useCoworkHome().data;
    const cards = useCoworkNeedCards(items);
    const shared = useSharedWithMe().data ?? [];
    const [flash, say] = useFlash();
    const homeElement = useRef<HTMLDivElement>(null);
    const finish = useCallback((_message: string, task: TaskToSetUp) => {
        // Home stays mounted behind other pages while setup finishes.
        if (homeElement.current && !homeElement.current.closest('[hidden]')) onOpenTask(task.id);
    }, [onOpenTask]);
    const { setup, begin } = useTaskSetup(finish);
    const created = useCallback((item: CoworkItem) => {
        void client.invalidateQueries({ queryKey: ['cowork'] });
        void begin(item);
    }, [client, begin]);
    return (
        <div ref={homeElement} className="cowork-home flex flex-col gap-9" data-testid="cowork-home">
            <CoworkHomeComposer guided={guided} openTask={onOpenTask} items={items} onAskTask={onAskTask} stepTypes={list.data?.stepTypes} atLimit={items.length >= maxItems} maxItems={maxItems} seed={seed}
                onTemplates={() => onOpenPanel({ kind: 'templates' })} onCreated={created} setup={setup} />
            {!guided && <div className="cowork-home-sections flex flex-col gap-9">
                <FlashLine flash={flash} />
                <CoworkHomeNotices budgetPercent={home?.budget?.percent} />
                <NeedsSection cards={cards} onOpenTask={onOpenTask} onDone={say} />
                <TasksSection list={list} items={items} cards={cards} home={home} testingId={null} onOpen={(id) => onOpenTask(id)} />
                {shared.length > 0 && (
                    <Section id="shared" heading={t('cowork_home.shared.heading', 'Shared with you')}>
                        <CoworkSharedRows items={shared} onOpen={(id) => onOpenPanel({ kind: 'shared', id })} />
                    </Section>
                )}
                <TeamworkEntry onOpen={() => onOpenPanel({ kind: 'teamwork' })} />
            </div>}
        </div>
    );
}
