/**
 * "Start from a template", next to the starters on the Cowork home (./CoworkPage.tsx): the coworks colleagues saved
 * for the organisation. One of them shows its brief, its schedule and what its plan may do, in the words of the plan
 * card (./CoworkPlanCard.tsx MayDo); the server works that out from the plan itself each time. "Add to my cowork"
 * makes a new item, paused, whose plan waits for its owner's approval: adding runs nothing.
 */
import { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { packageUrl, useAddCoworkTemplate, useCoworkTemplate, useCoworkTemplates, useDeleteCoworkTemplate } from '../../api/coworkTemplates';
import type { TemplateView } from '../../api/coworkTemplates';
import { useTranslation } from '../../hooks/useTranslation';
import type { TranslateFn } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { MayDo } from './CoworkPlanCard';
import CoworkPackageImport from './CoworkPackageImport';
import { repeatLabel } from './coworkSchedule';

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const PRIMARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]';
const SECONDARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

function PlanPart({ plan, t }: { plan: TemplateView['plan']; t: TranslateFn }) {
    if (!plan) return <p className="text-[12px] text-[var(--text-secondary)]">{t('cowork_templates.no_plan', 'No plan: it runs as a brief, with the apps you give it.')}</p>;
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-template-plan">
            <span className={LABEL}>{t('cowork_templates.may_do', 'What its plan may do')}</span>
            <MayDo permissions={plan.permissions} t={t} />
            {plan.findings.length > 0 && (
                <div className="flex flex-col gap-0.5" role="note">
                    <span className="text-[12px] text-[var(--warning-ink)]">{t('cowork_templates.plan_left_out', 'Its plan cannot run as it is, so it is left out. You can make a plan after adding it.')}</span>
                    {plan.findings.map((f) => <span key={`${f.code}-${f.stepId ?? ''}`} className="text-[12px] text-[var(--text-secondary)]">{f.message}</span>)}
                </div>
            )}
        </div>
    );
}

function TemplateDetail({ id, onBack, onAdded, t }: { id: string; onBack: () => void; onAdded: (coworkId: string) => void; t: TranslateFn }) {
    const view = useCoworkTemplate(id);
    const add = useAddCoworkTemplate();
    const remove = useDeleteCoworkTemplate();
    const data = view.data;
    if (view.error) return <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(view.error)}</p>;
    if (!data) return <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_templates.loading', 'Loading…')}</p>;
    const { template, plan } = data;
    const failure = add.error ?? remove.error;
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-template-view">
            <div className="flex flex-col gap-0.5">
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{template.title}</h3>
                <span className="text-[12px] text-[var(--text-tertiary)]">
                    {repeatLabel(template.repeatInterval, t)}
                    {template.savedBy ? ` · ${t('cowork_templates.saved_by', 'saved by {name}', { name: template.savedBy })}` : ''}
                </span>
            </div>
            <p className="text-[12.5px] whitespace-pre-wrap text-[var(--text-secondary)]">{template.brief}</p>
            <PlanPart plan={plan} t={t} />
            <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_templates.adds_paused', 'Adding it runs nothing: it starts paused, and you approve its plan after a try-out.')}</p>
            <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} disabled={add.isPending} onClick={() => add.mutate(id, { onSuccess: (used) => onAdded(used.item.id) })}>
                    {t('cowork_templates.add', 'Add to my cowork')}
                </button>
                <button type="button" className={SECONDARY} onClick={onBack}>{t('cowork_templates.back', 'Back to the templates')}</button>
                <a className={SECONDARY} href={packageUrl(id)} download>{t('cowork_templates.download', 'Download as a file')}</a>
                {template.canDelete && (
                    <button type="button" className={SECONDARY} disabled={remove.isPending} onClick={() => remove.mutate(id, { onSuccess: onBack })}>
                        {t('cowork_templates.delete', 'Delete this template')}
                    </button>
                )}
            </div>
            {failure && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(failure) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}

export default function CoworkTemplates({ onAdded }: { onAdded: (coworkId: string) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    const list = useCoworkTemplates(open);
    const templates = list.data ?? [];
    if (!open) {
        return (
            <button type="button" className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" onClick={() => setOpen(true)} data-testid="cowork-templates-open">
                <LayoutTemplate aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_templates.open', 'Start from a template')}
            </button>
        );
    }
    return (
        <section className="mt-4 w-full rounded-[10px] border px-[18px] py-3 flex flex-col gap-2 [border-color:var(--border-subtle)]" aria-labelledby="cowork-templates-heading" data-testid="cowork-templates">
            <div className="flex items-center justify-between gap-2">
                <h2 id="cowork-templates-heading" className="text-[12.5px] font-semibold text-[var(--text-primary)]">{t('cowork_templates.heading', 'Templates from your organisation')}</h2>
                <button type="button" className="text-[12px] text-[var(--text-tertiary)]" onClick={() => { setOpen(false); setOpenId(null); }}>{t('cowork_templates.close', 'Close')}</button>
            </div>
            {openId ? (
                <TemplateDetail id={openId} onBack={() => setOpenId(null)} onAdded={onAdded} t={t} />
            ) : (
                <>
                    {list.isSuccess && templates.length === 0 && (
                        <p className="text-[12px] text-[var(--text-secondary)]">{t('cowork_templates.empty', 'Your organisation has no templates yet. Save one from the settings of a cowork.')}</p>
                    )}
                    {list.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(list.error)}</p>}
                    <ul className="flex flex-col">
                        {templates.map((tpl) => (
                            <li key={tpl.id}>
                                <button type="button" className="w-full flex items-baseline gap-2 py-1 text-left text-[12.5px]" onClick={() => setOpenId(tpl.id)}>
                                    <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{tpl.title}</span>
                                    <span className="text-[12px] text-[var(--text-tertiary)]">{repeatLabel(tpl.repeatInterval, t)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <CoworkPackageImport onAdded={onAdded} />
                </>
            )}
        </section>
    );
}
