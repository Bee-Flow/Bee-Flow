/**
 * Two rows of "People" in an opened task (./CoworkTaskPeople.tsx), about where its work goes besides its owner:
 *
 *   - Send each result to a colleague's task: on a desk, a colleague's task that starts after this one gets each
 *     result once this task's owner allows it; the owner allows it here, or stops it (server usecases/coworkDesks.mts);
 *   - Save as template / Export as file: save it as a template for the organisation, and download that template as a
 *     package file signed by this installation (server usecases/coworkTemplates.mts, usecases/coworkPackages.mts).
 */
import { useState } from 'react';
import { BTN_PRIMARY, BTN_QUIET, CARD_SOFT, FIELD, Failure, LABEL, META, ROW_ACTIONS, TAG_OK } from './taskUi';
import { useDeskHandOff, useDeskView, useItemDesk, type DeskMember, type DeskView } from '@/api/coworkDesks';
import { packageUrl, useSaveCoworkTemplate } from '@/api/coworkTemplates';
import type { TranslateFn } from '@/hooks/useTranslation';

function PassLine({ member, deskId, t }: { member: DeskMember; deskId: string; t: TranslateFn }) {
    const { allow, withdraw } = useDeskHandOff(deskId);
    const busy = allow.isPending || withdraw.isPending;
    return (
        <li className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]">
            <span className="flex-1 min-w-[12rem]">
                {member.handOff === 'allowed'
                    ? t('cowork_task.pass.allowed', "Each result goes to {owner}'s task '{title}'.", { owner: member.ownerName, title: member.title })
                    : t('cowork_task.pass.waiting', "{owner}'s task '{title}' asks for each result of this task.", { owner: member.ownerName, title: member.title })}
            </span>
            {member.handOff === 'allowed'
                ? <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => withdraw.mutate(member.scheduleId)}>{t('cowork_task.pass.stop_sending', 'Stop sending it')}</button>
                : <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => allow.mutate(member.scheduleId)}>{t('cowork_task.pass.send', 'Send each result')}</button>}
            <Failure error={allow.error || withdraw.error} t={t} />
        </li>
    );
}

export type OpenHandOffDesk = (mode: 'setup' | 'join', message: string) => void;

export function PassBody({ coworkId, request, onTeamwork, t }: { coworkId: string; request?: string; onTeamwork?: OpenHandOffDesk; t: TranslateFn }) {
    const membership = useItemDesk(coworkId);
    const desk = membership.data;
    const detail = useDeskView(desk?.accepted ? desk.id : null);
    const view = detail.data;
    // A colleague's task that starts after this one, whose hand-off this task's owner decides.
    const after = (view?.members ?? []).filter((m) => m.after === coworkId && m.decidesHandOff && m.handOff !== null);
    if (membership.error || detail.error) return <Failure error={membership.error ?? detail.error} t={t} />;
    if (membership.isPending || (desk?.accepted && detail.isPending)) return <p role="status" className={META}>{t('cowork_pages.loading', 'Loading…')}</p>;
    if (onTeamwork && !after.length) return <HandOffDesk desk={desk} request={request} open={onTeamwork} t={t} />;
    if (!view) return <p className={META}>{t('cowork_task.pass.no_desk', "Put this task on a desk with your colleagues under Teamwork. A colleague's task that starts after it can then get each result.")}</p>;
    return <PassRecipients view={view} after={after} t={t} />;
}

function PassRecipients({view, after, t}: {view: DeskView; after: DeskMember[]; t: TranslateFn}) {
    return (
        <>
            {after.length > 0
                ? <ul className="list-none m-0 p-0">{after.map((m) => <PassLine key={m.scheduleId} member={m} deskId={view.desk.id} t={t} />)}</ul>
                : <p className={META}>{t('cowork_task.pass.none', "On the desk '{desk}'. No colleague's task starts after this one yet.", { desk: view.desk.name })}</p>}
            <p className={META}>{t('cowork_task.pass.only_result', 'Only the result is sent, never access to your apps. You allow each colleague once.')}</p>
        </>
    );
}

function HandOffDesk({desk, request, open, t}: {desk?: {name: string; accepted: boolean} | null; request?: string; open: OpenHandOffDesk; t: TranslateFn}) {
    const waiting = desk && !desk.accepted;
    const message = request ?? t('cowork_task.people.pass', "Send each result to a colleague's task");
    return <div className="grid gap-2">
        <p className={META}>{desk?.accepted
            ? t('cowork_task.pass.none', "On the desk '{desk}'. No colleague's task starts after this one yet.", {desk:desk.name})
            : t('cowork_task.pass.desk_first', 'Connect the two tasks on a team desk to pass results between them.')}</p>
        <button type="button" className={BTN_QUIET + ' justify-self-start'} onClick={() => open(waiting ? 'join' : 'setup', desk ? message + ' · ' + desk.name : message)}>
            {waiting ? t('cowork_task.pass.review_invite', 'Review the desk invitation') : t('cowork_panels.team.propose', 'Propose a setup')}
        </button>
    </div>;
}

/** A file name from a title: "Weekly sales numbers" reads "weekly-sales-numbers". Plain string work, no pattern. */
function slugOf(title: string): string {
    const words: string[] = [];
    let word = '';
    for (const c of title.toLowerCase()) {
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) word += c;
        else if (word) { words.push(word); word = ''; }
    }
    if (word) words.push(word);
    return words.join('-') || 'task';
}

export function TemplateBody({ coworkId, title, t }: { coworkId: string; title: string; t: TranslateFn }) {
    const [name, setName] = useState(title);
    const save = useSaveCoworkTemplate(coworkId);
    const saved = save.data?.template ?? null;
    const trimmed = name.trim();
    const id = `cowork-task-template-${coworkId}`;
    return (
        <>
            <div className="flex flex-wrap items-end gap-2">
                <span className="flex-[1_1_220px] min-w-0 flex flex-col gap-1">
                    <label htmlFor={id} className={LABEL}>{t('cowork_task.template.label', 'Save as a template for your organisation')}</label>
                    <input id={id} type="text" className={FIELD} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                </span>
                <button type="button" className={BTN_QUIET} disabled={!trimmed || save.isPending || saved?.title === trimmed} onClick={() => save.mutate(trimmed)}>
                    {saved?.title === trimmed ? t('cowork_task.template.saved_button', 'Saved') : t('cowork_task.template.save', 'Save as template')}
                </button>
            </div>
            {saved ? (
                <div className={CARD_SOFT} role="status" data-testid="cowork-task-package">
                    <span>{t('cowork_task.template.saved', "Saved. Colleagues find it under 'Start from a template'. Your data and memory are not part of it.")}</span>
                    {save.data?.warnings.map((w) => <span key={w} className={META}>{w}</span>)}
                    <span className={ROW_ACTIONS}>
                        <a className={BTN_QUIET} href={packageUrl(saved.id)} download={`${slugOf(saved.title)}.beeflow`}>{t('cowork_task.template.export', 'Export as file')}</a>
                        <span className={TAG_OK}>{t('cowork_task.template.signed', 'Signed')}</span>
                    </span>
                    <span className={META}>{t('cowork_task.template.package_hint', 'Whoever adds it sees that your organisation signed it and that nothing was changed since.')}</span>
                </div>
            ) : <p className={META}>{t('cowork_task.template.export_first', 'Save it as a template first; then you can export it as a signed file.')}</p>}
            <Failure error={save.error} t={t} />
        </>
    );
}
