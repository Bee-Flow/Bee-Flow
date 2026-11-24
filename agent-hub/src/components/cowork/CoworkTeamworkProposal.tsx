/**
 * Step two of the Teamwork helper (./CoworkTeamworkHelper.tsx): the proposal as a few plain sentences, each part
 * changeable with a small dropdown. The coworks and people offered are only those the helper's server side found the
 * person may use (server/usecases/coworkDeskHelper.mts); what it could not match is said plainly, next to its dropdown.
 */
import { Minus, Plus } from 'lucide-react';
import type { DeskProposal, HelperCowork, HelperPerson } from '@/api/coworkDeskHelper';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { agreesFirst, MAX_STEPS, type EditDraft, type EditRole, type EditStep } from './coworkTeamworkModel';

export const FIELD = 'rounded-lg border px-2 py-1 text-[12px] bg-[var(--bg-primary)] [border-color:var(--border-default)] max-w-full';
const LINK = 'inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] underline underline-offset-2 disabled:opacity-50';
const NOTE = 'text-[12px] text-[var(--text-tertiary)]';

const coworkLabel = (c: HelperCowork, t: TranslateFn): string => (c.mine
    ? t('cowork_teamwork.cowork_mine', '{title} (you)', { title: c.title })
    : t('cowork_teamwork.cowork_theirs', '{title} ({owner})', { title: c.title, owner: c.ownerName }));
const personLabel = (p: HelperPerson, t: TranslateFn): string => (p.me ? t('cowork_teamwork.person_me', '{name} (you)', { name: p.name }) : p.name);

function Step({ step, n, choices, onChange, onRemove }: { step: EditStep; n: number; choices: HelperCowork[]; onChange: (id: string) => void; onRemove: () => void }) {
    const { t } = useTranslation();
    const asks = n > 1 ? agreesFirst(step, choices) : null;
    const invited = n === 1 ? agreesFirst(step, choices) : null;
    return (
        <li className="flex flex-col gap-1" data-testid="cowork-teamwork-step">
            {step.words && !step.scheduleId && (
                <p className={NOTE}>{t('cowork_teamwork.no_cowork', 'I could not find a cowork for "{words}". Choose one:', { words: step.words })}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                <span aria-hidden="true">{n}.</span>
                <select aria-label={t('cowork_teamwork.step_label', 'Step {n}', { n })} className={FIELD} value={step.scheduleId} onChange={(e) => onChange(e.target.value)}>
                    <option value="">{t('cowork_teamwork.choose_cowork', 'Choose a cowork')}</option>
                    {choices.map((c) => <option key={c.scheduleId} value={c.scheduleId}>{coworkLabel(c, t)}</option>)}
                </select>
                <button type="button" className={LINK} onClick={onRemove} aria-label={t('cowork_teamwork.leave_out', 'Leave out step {n}', { n })}>
                    <Minus aria-hidden="true" className="w-3 h-3" />
                </button>
            </div>
            {(asks ?? invited) && (
                <p className={NOTE}>{asks
                    ? t('cowork_teamwork.asked_to_agree', 'It starts after step {prev}. {name} is asked to agree.', { prev: n - 1, name: asks })
                    : t('cowork_teamwork.asked_to_join', '{name} is asked to agree.', { name: invited ?? '' })}</p>
            )}
        </li>
    );
}

function Role({ role, people, onChange, onRemove }: { role: EditRole; people: HelperPerson[]; onChange: (r: EditRole) => void; onRemove: () => void }) {
    const { t } = useTranslation();
    const holder = people.find((p) => p.id === role.holderId);
    return (
        <div className="flex flex-col gap-1" data-testid="cowork-teamwork-role">
            {role.holderWords && !role.holderId && (
                <p className={NOTE}>{t('cowork_teamwork.no_person', 'I could not find "{words}" among your colleagues. Choose who:', { words: role.holderWords })}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                <span>{t('cowork_teamwork.questions_go_to', 'Questions go to')}</span>
                <input aria-label={t('cowork_teamwork.role_name', 'Name of the role')} className={`${FIELD} w-32`} value={role.role} maxLength={40} onChange={(e) => onChange({ ...role, role: e.target.value })} />
                <select aria-label={t('cowork_teamwork.holder', 'Who answers the questions')} className={FIELD} value={role.holderId} onChange={(e) => onChange({ ...role, holderId: e.target.value, standInId: role.standInId === e.target.value ? '' : role.standInId })}>
                    <option value="">{t('cowork_teamwork.choose_person', 'Choose a colleague')}</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{personLabel(p, t)}</option>)}
                </select>
                <button type="button" className={LINK} onClick={onRemove} aria-label={t('cowork_teamwork.no_role', 'Leave the questions out')}>
                    <Minus aria-hidden="true" className="w-3 h-3" />
                </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                <span>{t('cowork_teamwork.when_away', 'When {name} is away:', { name: holder?.name ?? t('cowork_teamwork.they', 'they') })}</span>
                <select aria-label={t('cowork_teamwork.stand_in', 'Who stands in')} className={FIELD} value={role.standInId} onChange={(e) => onChange({ ...role, standInId: e.target.value })}>
                    <option value="">{t('cowork_teamwork.nobody', 'Nobody')}</option>
                    {people.filter((p) => p.id !== role.holderId).map((p) => <option key={p.id} value={p.id}>{personLabel(p, t)}</option>)}
                </select>
            </div>
        </div>
    );
}

export default function CoworkTeamworkProposal({ proposal, draft, onChange }: { proposal: DeskProposal; draft: EditDraft; onChange: (d: EditDraft) => void }) {
    const { t } = useTranslation();
    const { coworks, people } = proposal.choices;
    const setStep = (i: number, scheduleId: string) => onChange({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { scheduleId, words: s.words } : s)) });
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-teamwork-proposal">
            {!proposal.drafted && <p className={NOTE}>{t('cowork_teamwork.not_drafted', 'I could not work that out just now. Choose below what should happen.')}</p>}
            {!proposal.deskId && (
                <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                    {t('cowork_teamwork.desk_name', 'The desk is called')}
                    <input className={`${FIELD} w-48`} value={draft.deskName} maxLength={80} onChange={(e) => onChange({ ...draft, deskName: e.target.value })} />
                </label>
            )}
            <ol className="flex flex-col gap-2" aria-label={t('cowork_teamwork.steps', 'The order work moves in')}>
                {draft.steps.map((s, i) => (
                    <Step key={i} step={s} n={i + 1} choices={coworks} onChange={(id) => setStep(i, id)} onRemove={() => onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })} />
                ))}
            </ol>
            {draft.steps.length < MAX_STEPS && (
                <button type="button" className={`${LINK} self-start`} onClick={() => onChange({ ...draft, steps: [...draft.steps, { scheduleId: '', words: '' }] })}>
                    <Plus aria-hidden="true" className="w-3 h-3" />{t('cowork_teamwork.add_step', 'Add a step')}
                </button>
            )}
            {draft.role
                ? <Role role={draft.role} people={people} onChange={(role) => onChange({ ...draft, role })} onRemove={() => onChange({ ...draft, role: null })} />
                : (
                    <button type="button" className={`${LINK} self-start`} onClick={() => onChange({ ...draft, role: { role: t('cowork_teamwork.default_role', 'Questions'), holderId: '', standInId: '', holderWords: '' } })}>
                        <Plus aria-hidden="true" className="w-3 h-3" />{t('cowork_teamwork.add_role', 'Say who answers questions')}
                    </button>
                )}
        </div>
    );
}
