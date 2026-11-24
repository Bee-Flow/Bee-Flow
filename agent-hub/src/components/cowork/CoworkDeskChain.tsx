/**
 * The coworks of a desk in the order work moves along them, each with its owner and its last status, never what
 * another owner's runs read or produced (server/usecases/coworkDesks.mts). Shown in an item's Settings tab
 * (./CoworkDeskPanel.tsx) and on the Cowork home (./CoworkDesks.tsx).
 *
 * A colleague's cowork that starts after one of mine receives its result only once I allow it: under it, one line
 * with "Allow" (or "Stop", once allowed). Its owner reads that it waits for me.
 */
import { ArrowDown } from 'lucide-react';
import { runStatusToken } from './coworkStatus';
import { useDeskHandOff, type DeskMember } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';

const SMALL_BUTTON = 'px-2 py-0.5 rounded-md border text-[11.5px] font-medium [border-color:var(--border-default)] disabled:opacity-50';

/** The hand-off line under a member that starts after a colleague's cowork; nothing for anyone else. */
function HandOffLine({ deskId, member, leader, t }: { deskId: string; member: DeskMember; leader: DeskMember | undefined; t: TranslateFn }) {
    const { allow, withdraw } = useDeskHandOff(deskId);
    if (!member.handOff || !leader) return null;
    const title = leader.title || t('cowork_needs.untitled', 'Untitled work');
    const failed = allow.error ?? withdraw.error;
    if (!member.decidesHandOff) {
        if (!member.mine || member.handOff === 'allowed') return null;
        return <p className="text-[11.5px] text-[var(--text-tertiary)]" data-testid="cowork-desk-hand-off">{t('cowork_desks.hand_off.waiting', 'Receives nothing until {owner} allows it to get the result of "{title}".', { owner: leader.ownerName, title })}</p>;
    }
    const allowed = member.handOff === 'allowed';
    return (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-secondary)]" data-testid="cowork-desk-hand-off">
            <span>{allowed
                ? t('cowork_desks.hand_off.allowed', 'Receives the result of your "{title}".', { title })
                : t('cowork_desks.hand_off.asks', 'Asks to receive the result of your "{title}". It runs as {owner}.', { title, owner: member.ownerName })}</span>
            {allowed
                ? <button type="button" className={SMALL_BUTTON} disabled={withdraw.isPending} onClick={() => withdraw.mutate(member.scheduleId)}>{t('cowork_desks.hand_off.withdraw', 'Stop sending it')}</button>
                : <button type="button" className={SMALL_BUTTON} disabled={allow.isPending} onClick={() => allow.mutate(member.scheduleId)}>{t('cowork_desks.hand_off.allow', 'Allow')}</button>}
            {failed && <span role="alert" className="text-[var(--error-ink)]">{errorMessage(failed) || t('cowork_desks.failed', 'That did not work. Try again.')}</span>}
        </div>
    );
}

export default function CoworkDeskChain({ deskId, members, onOpen }: { deskId: string; members: DeskMember[]; onOpen?: (itemId: string) => void }) {
    const { t } = useTranslation();
    if (members.length === 0) return <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_desks.empty', 'No coworks on this desk yet.')}</p>;
    return (
        <ol className="flex flex-col" data-testid="cowork-desk-chain">
            {members.map((m, i) => {
                const token = runStatusToken(m.lastStatus);
                const title = m.title || t('cowork_needs.untitled', 'Untitled work');
                return (
                    <li key={m.scheduleId} className="flex flex-col text-[12px]" data-testid="cowork-desk-member">
                        {i > 0 && m.after && <ArrowDown aria-hidden="true" className="w-3 h-3 my-0.5 text-[var(--text-tertiary)]" />}
                        <div className="flex items-baseline gap-2">
                            {m.mine && onOpen
                                ? <button type="button" className="flex-1 min-w-0 truncate text-left underline underline-offset-2 text-[var(--text-primary)]" onClick={() => onOpen(m.scheduleId)}>{title}</button>
                                : <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{title}</span>}
                            <span className="text-[var(--text-tertiary)]">
                                {/* The owner by name, not a possessive without its noun ("Lena Moreau's · Finished"). */}
                                {m.mine ? t('cowork_desks.yours', 'yours') : m.ownerName}
                                {!m.accepted && ` · ${t('cowork_desks.invited', 'invited')}`}
                                {m.lastStatus && ` · ${t(token.labelKey, token.labelEn)}`}
                            </span>
                        </div>
                        <HandOffLine deskId={deskId} member={m} leader={members.find((l) => l.scheduleId === m.after)} t={t} />
                    </li>
                );
            })}
        </ol>
    );
}
