/**
 * The Cowork home, one calm column, top to bottom:
 *
 *   1. the composer: "What should be done for you?", one confirmation card, then the visible set-up and test of the
 *      new task's steps (./CoworkHomeComposer.tsx);
 *   2. the notices: the organisation's budget from 80%, read-only mode (./CoworkHomeNotices.tsx);
 *   3. Needs you: at most three cards (./CoworkNeedCard.tsx), the rest behind "Show N more";
 *   4. Your tasks: title, status, when, next run, goal (./CoworkTaskRows.tsx);
 *   5. Shared with you and Teamwork, each only when it has something.
 *
 * A task, Templates and Teamwork open in the page's sheet (./CoworkPage.tsx): this column only asks for them.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import CoworkHomeComposer from './CoworkHomeComposer';
import CoworkHomeNotices from './CoworkHomeNotices';
import CoworkNeedCard from './CoworkNeedCard';
import type { TaskFocus } from './CoworkNeedFrame';
import CoworkTaskRows, { CoworkSharedRows, TaskList } from './CoworkTaskRows';
import type { NeedCardData } from './coworkNeedsModel';
import type { CoworkSheetPanel } from './coworkSheetPanels';
import { CARD, LINK_BUTTON, SECTION_HEADING } from './coworkUi';
import useCoworkList from './useCoworkList';
import useCoworkNeedCards from './useCoworkNeedCards';
import useTaskSetup from './useTaskSetup';
import { useCoworkHome, type CoworkHome as CoworkHomeData } from '@/api/coworkHome';
import { useMyDesks } from '@/api/coworkDesks';
import { useSharedWithMe } from '@/api/coworkShares';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { CoworkItem } from '@/api/cowork.types';

const NEEDS_SHOWN = 3;
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
        <section aria-labelledby="cowork-needs-heading" className="flex flex-col gap-2.5" data-testid="cowork-needs">
            <h2 id="cowork-needs-heading" className={SECTION_HEADING}>{t('cowork_home.needs.heading', 'Needs you · {count}', { count: cards.length })}</h2>
            <div className={`${CARD} overflow-hidden divide-y divide-[var(--border-subtle)]`}>
                {shown.map((need) => <CoworkNeedCard key={need.key} need={need} onOpenTask={onOpenTask} onDone={onDone} />)}
            </div>
            {cards.length > NEEDS_SHOWN && (
                <button type="button" className={`${LINK_BUTTON} self-start ml-0`} aria-expanded={all} onClick={() => setAll((v) => !v)}>
                    {all ? t('cowork_home.needs.fewer', 'Show fewer') : t('cowork_home.needs.more', 'Show {count} more', { count: cards.length - NEEDS_SHOWN })}
                </button>
            )}
        </section>
    );
}

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
    return (
        <section aria-labelledby={`cowork-${id}-heading`} className="flex flex-col gap-2.5">
            <h2 id={`cowork-${id}-heading`} className={SECTION_HEADING}>{heading}</h2>
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
            {list.error && <p role="alert" className="text-[14px] text-[var(--error-ink)]">{errorMessage(list.error)}</p>}
            {items.length > 0 && <CoworkTaskRows items={items} cards={cards} home={home} testingId={testingId} onOpen={onOpen} />}
            {items.length === 0 && list.isSuccess && <p className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.tasks.empty', 'No tasks yet. Write one sentence above to start.')}</p>}
        </Section>
    );
}

/** The desks the owner is on, as rows that open Teamwork; nothing while they are on none. */
function TeamworkSection({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    const desks = useMyDesks().data ?? [];
    if (desks.length === 0) return null;
    return (
        <Section id="teamwork" heading={t('cowork_home.teamwork.heading', 'Teamwork')}>
            <TaskList testId="cowork-teamwork">
                {desks.map((desk) => (
                    <li key={desk.id} className="border-t first:border-t-0 border-[var(--border-subtle)]">
                        <button type="button" onClick={onOpen} className="w-full min-h-11 flex flex-col gap-0.5 px-4 py-3.5 text-left hover:bg-[var(--bg-tertiary)]">
                            <span className="font-semibold text-[15px] text-[var(--text-primary)]">{desk.name}</span>
                            {desk.isOwner && <span className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.teamwork.yours', 'Set up by you')}</span>}
                        </button>
                    </li>
                ))}
            </TaskList>
        </Section>
    );
}

/** One sentence after an action, said for a few seconds. */
function useFlash(): [string | null, (message: string) => void] {
    const [flash, setFlash] = useState<string | null>(null);
    useEffect(() => {
        if (!flash) return undefined;
        const timer = setTimeout(() => setFlash(null), 5000);
        return () => clearTimeout(timer);
    }, [flash]);
    return [flash, setFlash];
}

export interface CoworkHomeProps {
    onOpenTask: (itemId: string, focus?: TaskFocus) => void;
    onOpenPanel: (panel: CoworkSheetPanel) => void;
    /** A sentence to put in the composer (a template's). */
    seed?: { text: string; n: number } | null;
}

export default function CoworkHome({ onOpenTask, onOpenPanel, seed = null }: CoworkHomeProps) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const list = useCoworkList();
    const items = list.data?.items ?? NO_ITEMS;
    const maxItems = list.data?.maxItems ?? 10;
    const home = useCoworkHome().data;
    const cards = useCoworkNeedCards(items);
    const shared = useSharedWithMe().data ?? [];
    const [flash, say] = useFlash();
    const { setup, begin } = useTaskSetup(say);
    const created = useCallback((item: CoworkItem) => {
        void client.invalidateQueries({ queryKey: ['cowork'] });
        void begin({ id: item.id, title: item.title });
    }, [client, begin]);
    return (
        <div className="flex flex-col gap-7" data-testid="cowork-home">
            <CoworkHomeComposer atLimit={items.length >= maxItems} maxItems={maxItems} seed={seed} onTemplates={() => onOpenPanel({ kind: 'templates' })} onCreated={created} setup={setup} />
            {flash && <p role="status" className="text-[14px] text-[var(--text-secondary)]" data-testid="cowork-flash">{flash}</p>}
            <CoworkHomeNotices budgetPercent={home?.budget?.percent} />
            <NeedsSection cards={cards} onOpenTask={onOpenTask} onDone={say} />
            <TasksSection list={list} items={items} cards={cards} home={home} testingId={setup?.id ?? null} onOpen={(id) => onOpenTask(id)} />
            {shared.length > 0 && (
                <Section id="shared" heading={t('cowork_home.shared.heading', 'Shared with you')}>
                    <CoworkSharedRows items={shared} onOpen={(id) => onOpenPanel({ kind: 'shared', id })} />
                </Section>
            )}
            <TeamworkSection onOpen={() => onOpenPanel({ kind: 'teamwork' })} />
        </div>
    );
}
