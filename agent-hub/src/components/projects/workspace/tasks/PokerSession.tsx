// A running planning poker session, in one card: the item and its phase with
// the facilitator's controls, who has voted (or what they voted once
// revealed), the cards, and the queue of items still to estimate.

import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import {
    useCancelPokerSession, useCastPokerVote, useFinishPokerSession, useNextPokerTask, useRevealPokerVotes, type PokerSession as Session,
} from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { Avatar, GhostButton, PrimaryButton } from '../workspaceUi';
import { CARD, Chip, InfoTip, META, SECTION_LABEL } from './sprintUi';

type People = ReturnType<typeof useChatPeople>;
const POKER_ESTIMATES = [1, 2, 3, 5, 8, 13, 21];
const CARD_BUTTON = 'grid place-items-center w-11 h-14 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[15px] font-semibold tabular-nums text-[var(--text-primary)] '
    + 'transition-colors hover:bg-[var(--item-hover-bg)] aria-pressed:border-[var(--accent-primary)] aria-pressed:bg-[var(--item-active-bg)] disabled:opacity-60 '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

function Participants({ session, people, personName }: { session: Session; people: People; personName: (id: string) => string }) {
    const { t } = useTranslation();
    const shown = [...new Map([...people.people.map(p => [p.id, p] as const), ...session.voterIds.map(id => [id, { id, name: personName(id) }] as const)]).values()];
    return (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t('project_tasks.poker_participants', 'Participants')}>
            {shown.map(person => {
                const voted = session.voterIds.includes(person.id);
                const vote = session.votes?.[person.id];
                const state = session.phase === 'revealed'
                    ? (vote || t('project_tasks.poker_no_vote', 'No vote'))
                    : voted ? t('project_tasks.poker_ready', 'Ready') : t('project_tasks.poker_choosing', 'Choosing…');
                return (
                    <li key={person.id} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] pl-0.5 pr-2.5 text-[12px] text-[var(--text-secondary)]" title={`${person.name}: ${state}`}>
                        <Avatar name={person.name} size="sm" picture={people.avatarOf(person.id)} color={people.colorOf(person.id)} className="!ring-0" />
                        <span className="max-w-[8rem] truncate">{person.name}</span>
                        {session.phase === 'revealed'
                            ? <span className={`font-semibold tabular-nums ${vote ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>{vote || '–'}<span className="sr-only"> {state}</span></span>
                            : <span role="img" aria-label={state} className={`w-2 h-2 rounded-full ${voted ? 'bg-[var(--success)]' : 'border-[1.5px] border-[var(--text-tertiary)]'}`} />}
                    </li>
                );
            })}
        </ul>
    );
}

function Queue({ session }: { session: Session }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(true);
    const queue = session.queueTitles || [];
    return (
        <div className="space-y-1" data-testid="poker-queue">
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className={`${SECTION_LABEL} flex h-7 items-center gap-1 rounded hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]`}>
                {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
                {t('project_tasks.poker_up_next', 'Up next')}<span className="ml-1 font-normal tabular-nums">{queue.length}</span>
            </button>
            {open && (
                <ol className="m-0 list-none divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg bg-[var(--bg-secondary)] p-0">
                    {queue.map((title, i) => (
                        <li key={session.queueTaskIds?.[i] || i} className="flex h-8 items-center gap-2.5 px-3 text-[12.5px] text-[var(--text-secondary)]">
                            <span className="w-4 flex-none text-right tabular-nums text-[var(--text-tertiary)]">{i + 1}</span>
                            <span className="min-w-0 truncate">{title || t('project_tasks.poker_item_gone', 'An item that is no longer available')}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

/** The item, its phase and who started the session, with the facilitator's controls on the right. */
function SessionHeader({ session, startedBy, children }: { session: Session; startedBy: string; children: React.ReactNode }) {
    const { t } = useTranslation();
    const voting = session.phase === 'voting';
    const phaseHint = voting
        ? t('project_tasks.poker_phase_voting_hint', 'Live voting · votes are private until reveal')
        : t('project_tasks.poker_phase_revealed_hint', 'Votes revealed · agree on the final estimate');
    return (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <h3 className="m-0 min-w-0 truncate text-[14px] font-semibold text-[var(--text-primary)]">{session.taskTitle}</h3>
                    {voting
                        ? <Chip tone="info">{t('project_tasks.poker_voting_count', 'Voting · {count} voted', { count: session.voterIds.length })}</Chip>
                        : <Chip tone="success">{t('project_tasks.poker_revealed', 'Revealed')}</Chip>}
                </div>
                <p className={`m-0 flex items-center gap-1 ${META}`}>
                    {t('project_tasks.poker_started_by', 'Started by {name}', { name: startedBy })}
                    <InfoTip text={`${phaseHint}. ${t('project_tasks.poker_live_hint', 'Updates appear live for everyone in the project.')}`} />
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">{children}</div>
        </div>
    );
}

export default function PokerSession({ projectId, session, canEdit, people, startPending, outerError }: {
    projectId: string; session: Session; canEdit: boolean; people: People; startPending: boolean;
    /** A failed start or session fetch from the panel around it. */
    outerError?: Error | null;
}) {
    const { t } = useTranslation();
    const cast = useCastPokerVote(projectId);
    const reveal = useRevealPokerVotes(projectId);
    const finish = useFinishPokerSession(projectId);
    const next = useNextPokerTask(projectId);
    const cancel = useCancelPokerSession(projectId);
    const [agreed, setAgreed] = useState<number | null>(null);
    const pending = startPending || cast.isPending || reveal.isPending || finish.isPending || next.isPending || cancel.isPending;
    const error = outerError || cast.error || reveal.error || finish.error || next.error || cancel.error;
    const personName = (id: string) => people.nameOf(id) || t('project_chat.someone', 'A member');
    const queue = session.queueTitles || [];
    const voting = session.phase === 'voting';
    const save = () => {
        if (!agreed) return;
        // A queued session advances to the next item; the last one finishes it.
        if (queue.length) next.mutate({ sessionId: session.sessionId, storyPoints: agreed }, { onSuccess: () => setAgreed(null) });
        else finish.mutate({ sessionId: session.sessionId, storyPoints: agreed });
    };

    return (
        <section className={`${CARD} space-y-4 px-3.5 py-3`} aria-label={session.taskTitle}>
            <SessionHeader session={session} startedBy={personName(session.startedBy)}>
                {voting
                    ? <PrimaryButton disabled={!canEdit || pending} busy={reveal.isPending} onClick={() => reveal.mutate({ sessionId: session.sessionId })}>{t('project_tasks.poker_reveal', 'Reveal votes')}</PrimaryButton>
                    : <PrimaryButton disabled={!canEdit || !agreed || pending} busy={finish.isPending || next.isPending} onClick={save}>
                        {queue.length ? t('project_tasks.poker_save_next', 'Save estimate & next item') : t('project_tasks.poker_save_finish', 'Save estimate & finish')}
                    </PrimaryButton>}
                <GhostButton className="h-8 px-2.5" disabled={!canEdit || pending} onClick={() => cancel.mutate({ sessionId: session.sessionId })}>{t('project_tasks.poker_end', 'End session')}</GhostButton>
            </SessionHeader>

            <Participants session={session} people={people} personName={personName} />

            <div className="space-y-2">
                <h4 className={SECTION_LABEL}>{voting ? t('project_tasks.poker_your_card', 'Your card') : t('project_tasks.poker_agreed', 'Agreed estimate')}</h4>
                <div className="flex flex-wrap gap-2">
                    {voting
                        ? [...POKER_ESTIMATES.map(String), '?'].map(card => (
                            <button key={card} type="button" disabled={pending} aria-pressed={session.ownVote === card} className={CARD_BUTTON}
                                onClick={() => cast.mutate({ sessionId: session.sessionId, vote: card })}>{card}</button>
                        ))
                        : POKER_ESTIMATES.map(point => (
                            <button key={point} type="button" aria-pressed={agreed === point} className={CARD_BUTTON} onClick={() => setAgreed(point)}>{point}</button>
                        ))}
                </div>
                {voting && <p className={`m-0 ${META}`}>{t('project_tasks.poker_change_hint', 'You can change your card until the facilitator reveals the votes.')}</p>}
            </div>

            {queue.length > 0 && <Queue session={session} />}
            {error && <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{error.message}</p>}
        </section>
    );
}
