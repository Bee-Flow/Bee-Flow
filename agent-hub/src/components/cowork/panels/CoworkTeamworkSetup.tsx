/**
 * "Send each result to a colleague's task", on the Teamwork page: one sentence about who does what, a proposal the
 * person changes with dropdowns (which task sends its result to which, who answers questions and who stands in), and
 * "Send invitations".
 * The proposal comes from POST /api/cowork/desks/helper/draft and makes nothing; sending goes through the desk's own
 * rules (POST /api/cowork/desks/helper/apply): a colleague accepts once before their task joins, and a chain stops after
 * the result went from one person to another three times. The edit model is ../coworkTeamworkModel.ts, shared with the helper of an
 * item's settings.
 */
import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useApplyDeskDraft, useDraftDesk, type DeskProposal, type HelperCowork, type HelperPerson, type HelperResult } from '@/api/coworkDeskHelper';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { agreesFirst, bodyOf, editableOf, MAX_STEPS, noteText, notReady, type EditDraft, type EditRole, type NotReady } from '../coworkTeamworkModel';
import { BODY, CARD, INPUT, LabeledField, META, PanelButton, PanelSection, Problem } from './panelParts';

const taskLabel = (c: HelperCowork, t: TranslateFn): string => (c.mine
    ? t('cowork_panels.team.task_mine', '{title} (you)', { title: c.title })
    : t('cowork_panels.team.task_theirs', '{title} ({owner})', { title: c.title, owner: c.ownerName }));
const personLabel = (p: HelperPerson, t: TranslateFn): string => (p.me ? t('cowork_panels.team.person_me', '{name} (you)', { name: p.name }) : p.name);

function whyNot(reason: NotReady, t: TranslateFn): string {
    switch (reason) {
        case 'no_steps': return t('cowork_panels.team.not_ready.no_steps', 'Choose at least one task.');
        case 'unchosen': return t('cowork_panels.team.not_ready.unchosen', 'Choose a task in every dropdown.');
        case 'twice': return t('cowork_panels.team.not_ready.twice', 'Each task can come once.');
        case 'crossings': return t('cowork_panels.team.not_ready.too_far', 'A result can go from one person to another 3 times at most. Leave a task out.');
        case 'holder': return t('cowork_panels.team.not_ready.holder', 'Choose who answers the questions, or leave that out.');
        case 'name': return t('cowork_panels.team.not_ready.name', 'Give it a name.');
    }
}

function StepFields({ draft, tasks, onChange }: { draft: EditDraft; tasks: HelperCowork[]; onChange: (d: EditDraft) => void }) {
    const { t } = useTranslation();
    const setStep = (i: number, scheduleId: string) => onChange({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { scheduleId, words: '' } : s)) });
    return (
        <>
            {draft.steps.map((step, i) => {
                const asks = i > 0 ? agreesFirst(step, tasks) : null;
                return (
                    <div key={i} className="flex flex-col gap-1" data-testid="cowork-team-step">
                        {step.words && !step.scheduleId && <p className={`m-0 ${META}`}>{t('cowork_panels.team.no_task', 'I could not find a task for “{words}”. Choose one:', { words: step.words })}</p>}
                        <div className="flex items-end gap-2">
                            <LabeledField id={`cowork-team-step-${i}`} label={i === 0 ? t('cowork_panels.team.send_of', 'Send each result of') : t('cowork_panels.team.pass_to', 'To this task')}>
                                <select id={`cowork-team-step-${i}`} className={INPUT} value={step.scheduleId} onChange={(e) => setStep(i, e.target.value)}>
                                    <option value="">{t('cowork_panels.team.choose_task', 'Choose a task')}</option>
                                    {tasks.map((c) => <option key={c.scheduleId} value={c.scheduleId}>{taskLabel(c, t)}</option>)}
                                </select>
                            </LabeledField>
                            {i > 0 && (
                                <PanelButton look="icon" aria-label={t('cowork_panels.team.remove_task', 'Do not send it to task {n}', { n: i + 1 })} onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}>
                                    <Minus aria-hidden="true" size={16} />
                                </PanelButton>
                            )}
                        </div>
                        {asks && <p className={`m-0 ${META}`}>{t('cowork_panels.team.asked_to_accept', '{name} is asked to accept once.', { name: asks })}</p>}
                    </div>
                );
            })}
            {draft.steps.length < MAX_STEPS && (
                <PanelButton look="link" className="self-start" onClick={() => onChange({ ...draft, steps: [...draft.steps, { scheduleId: '', words: '' }] })}>
                    <Plus aria-hidden="true" size={16} />{t('cowork_panels.team.send_on', 'Send it on to another task')}
                </PanelButton>
            )}
        </>
    );
}

function RoleFields({ role, people, onChange, onRemove }: { role: EditRole; people: HelperPerson[]; onChange: (r: EditRole) => void; onRemove: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-team-role">
            {role.holderWords && !role.holderId && <p className={`m-0 ${META}`}>{t('cowork_panels.team.no_person', 'I could not find “{words}” among your colleagues. Choose who:', { words: role.holderWords })}</p>}
            <div className="flex flex-col gap-2 sm:flex-row">
                <LabeledField id="cowork-team-role-name" label={t('cowork_panels.team.role', 'Role')}>
                    <input id="cowork-team-role-name" className={INPUT} maxLength={40} value={role.role} onChange={(e) => onChange({ ...role, role: e.target.value })} />
                </LabeledField>
                <LabeledField id="cowork-team-role-who" label={t('cowork_panels.team.who', 'Who')}>
                    <select id="cowork-team-role-who" className={INPUT} value={role.holderId} onChange={(e) => onChange({ ...role, holderId: e.target.value, standInId: role.standInId === e.target.value ? '' : role.standInId })}>
                        <option value="">{t('cowork_panels.team.choose_person', 'Choose a colleague')}</option>
                        {people.map((p) => <option key={p.id} value={p.id}>{personLabel(p, t)}</option>)}
                    </select>
                </LabeledField>
                <LabeledField id="cowork-team-role-standin" label={t('cowork_panels.team.stand_in', 'Stand-in')}>
                    <select id="cowork-team-role-standin" className={INPUT} value={role.standInId} onChange={(e) => onChange({ ...role, standInId: e.target.value })}>
                        <option value="">{t('cowork_panels.team.nobody', 'Nobody')}</option>
                        {people.filter((p) => p.id !== role.holderId).map((p) => <option key={p.id} value={p.id}>{personLabel(p, t)}</option>)}
                    </select>
                </LabeledField>
            </div>
            <p className={`m-0 ${META}`}>{t('cowork_panels.team.away_note', 'When someone is away, a question for them goes to their stand-in.')}</p>
            <PanelButton look="link" className="self-start" onClick={onRemove}>{t('cowork_panels.team.no_role', 'Leave this out')}</PanelButton>
        </div>
    );
}

export function DeskProposalForm({ proposal, itemId, onBack, onDone }: { proposal: DeskProposal; itemId?: string; onBack: () => void; onDone: (r: HelperResult) => void }) {
    const { t } = useTranslation();
    const apply = useApplyDeskDraft();
    const [draft, setDraft] = useState<EditDraft>(() => editableOf(proposal));
    const { coworks: tasks, people } = proposal.choices;
    const waits = notReady(draft, tasks, !proposal.deskId);
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-team-proposal">
            <p className={`m-0 ${META}`}>{proposal.drafted
                ? t('cowork_panels.team.proposal_intro', 'This is what Cowork made of it. Change what is not right. Nothing is sent yet.')
                : t('cowork_panels.team.not_drafted', 'Cowork could not work that out just now. Choose below what should happen. Nothing is sent yet.')}</p>
            {!proposal.deskId && (
                <LabeledField id="cowork-team-name" label={t('cowork_panels.team.name', 'Name')}>
                    <input id="cowork-team-name" className={INPUT} maxLength={80} value={draft.deskName} onChange={(e) => setDraft({ ...draft, deskName: e.target.value })} />
                </LabeledField>
            )}
            <StepFields draft={draft} tasks={tasks} onChange={setDraft} />
            {draft.role
                ? <RoleFields role={draft.role} people={people} onChange={(role) => setDraft({ ...draft, role })} onRemove={() => setDraft({ ...draft, role: null })} />
                : (
                    <PanelButton look="link" className="self-start" onClick={() => setDraft({ ...draft, role: { role: t('cowork_panels.team.default_role', 'Answers the questions'), holderId: '', standInId: '', holderWords: '' } })}>
                        <Plus aria-hidden="true" size={16} />{t('cowork_panels.team.add_role', 'Say who answers questions')}
                    </PanelButton>
                )}
            <p className={`m-0 ${META}`}>{t('cowork_panels.team.only_result', 'Only the result is sent on, never access to anyone’s apps. Each colleague accepts once. A result goes from one person to another 3 times at most.')}</p>
            {waits && <p className={`m-0 ${META}`} data-testid="cowork-team-not-ready">{whyNot(waits, t)}</p>}
            <div className="flex flex-wrap gap-2">
                <PanelButton busy={apply.isPending} disabled={!!waits} onClick={() => apply.mutate({ itemId, expectedDeskId: itemId ? proposal.deskId : undefined, draft: bodyOf(draft) }, { onSuccess: onDone })}>{t('cowork_panels.team.send', 'Send invitations')}</PanelButton>
                <PanelButton look="inline" disabled={apply.isPending} onClick={onBack}>{t('cowork_panels.team.start_over', 'Start over')}</PanelButton>
            </div>
            <Problem error={apply.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
        </div>
    );
}

export function DeskSetupResult({ result, onAgain }: { result: HelperResult; onAgain: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2" role="status" data-testid="cowork-team-sent">
            <p className={`${BODY} font-semibold`}>{t('cowork_panels.team.sent', 'Done. Invitations are sent.')}</p>
            <ul className={`m-0 flex list-disc flex-col gap-1 pl-5 ${META}`}>
                {[...result.done, ...result.waiting].map((n, i) => <li key={i}>{noteText(n, t)}</li>)}
            </ul>
            <PanelButton look="link" className="self-start" onClick={onAgain}>{t('cowork_panels.team.another', 'Set up another')}</PanelButton>
        </div>
    );
}

type Screen = { at: 'words' } | { at: 'proposal'; proposal: DeskProposal } | { at: 'sent'; result: HelperResult };

export default function CoworkTeamworkSetup({ another }: { another: boolean }) {
    const { t } = useTranslation();
    const draft = useDraftDesk();
    const [screen, setScreen] = useState<Screen>({ at: 'words' });
    const [text, setText] = useState('');
    return (
        <PanelSection title={another ? t('cowork_panels.team.another_heading', 'Set up another') : t('cowork_panels.team.send_heading', 'Send each result to a colleague’s task')}>
            <div className={CARD}>
                {screen.at === 'words' && (
                    <>
                        <LabeledField id="cowork-team-words" label={t('cowork_panels.team.words_label', 'Who does what? Say it in one sentence.')}>
                            <textarea id="cowork-team-words" rows={3} maxLength={1000} className={INPUT} value={text} onChange={(e) => setText(e.target.value)}
                                placeholder={t('cowork_panels.team.words_placeholder', 'Sam collects the supplier mails, I answer them, Noor steps in when I am away')} />
                        </LabeledField>
                        <div>
                            <PanelButton busy={draft.isPending} disabled={!text.trim()} onClick={() => draft.mutate({ text: text.trim() }, { onSuccess: (proposal) => setScreen({ at: 'proposal', proposal }) })}>
                                {t('cowork_panels.team.propose', 'Propose a setup')}
                            </PanelButton>
                        </div>
                        <Problem error={draft.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
                    </>
                )}
                {screen.at === 'proposal' && <DeskProposalForm proposal={screen.proposal} onBack={() => setScreen({ at: 'words' })} onDone={(result) => setScreen({ at: 'sent', result })} />}
                {screen.at === 'sent' && <DeskSetupResult result={screen.result} onAgain={() => { setText(''); setScreen({ at: 'words' }); }} />}
            </div>
        </PanelSection>
    );
}
