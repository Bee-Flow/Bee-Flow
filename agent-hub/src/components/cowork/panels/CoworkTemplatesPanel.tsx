/**
 * Templates, a page of Cowork ("Start from a template" under the composer opens it): what colleagues saved for the
 * organisation (GET /api/cowork/templates), each with "Use", which hands its sentence to the composer on the home; and
 * "Add a task from a file": a task someone exported as a signed file. The server checks the signature first (POST
 * /api/cowork/packages/preview) and the page says who signed it before "Add as a paused task" (POST
 * /api/cowork/packages/add) makes anything; the new task then opens as its page. Adding runs nothing.
 */
import { useContext, useState } from 'react';
import { GuidedPanelContext } from './panelGuidance';
import { ShieldCheck } from 'lucide-react';
import { useAddPackage, useCoworkTemplates, usePreviewPackage, type PackagePreview } from '@/api/coworkTemplates';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { MayDo } from '../CoworkPlanCard';
import { repeatLabel } from '../coworkSchedule';
import { STAGGER } from '../coworkMotion';
import { ALERT, BUTTON_SECONDARY } from '../coworkUi';
import { BODY, CARD, EYEBROW, META, PanelButton, PanelLoading, PanelOverview, PanelReadProblem, PanelSection, PanelShell, Problem } from './panelParts';

const MAX_FILE_BYTES = 1_000_000;

/** Who signed the package, in plain words. */
function signerText(signedBy: PackagePreview['signedBy'], t: TranslateFn): string {
    if (!signedBy.thisInstallation) return t('cowork_panels.templates.signer_elsewhere', 'Signed by another Bee Flow (key {key}).', { key: signedBy.keyId });
    if (signedBy.organisation === 'your_organisation') return t('cowork_panels.templates.signer_yours', 'Signed by your organisation.');
    if (signedBy.organisation === 'another_organisation') return t('cowork_panels.templates.signer_other_org', 'Signed by another organisation on this Bee Flow, not yours.');
    return t('cowork_panels.templates.signer_unknown', 'Signed on this Bee Flow, but the file does not say by which organisation.');
}

function PackagePreviewCard({ pkg, shown, onOpenTask, onCancel }: { pkg: Record<string, unknown>; shown: PackagePreview; onOpenTask: (id: string) => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const add = useAddPackage();
    const known = shown.signedBy.thisInstallation && shown.signedBy.organisation === 'your_organisation';
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-panels-package-preview">
            <div className={`flex items-start gap-2 ${BODY}`} role="status">
                <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
                <span>
                    {t('cowork_panels.templates.signature_checked', 'Signature checked.')} {signerText(shown.signedBy, t)} {t('cowork_panels.templates.unchanged', 'Nothing was changed since it was signed.')}
                    {!known && ` ${t('cowork_panels.templates.only_if_known', 'Add it only if you know where it comes from.')}`}
                </span>
            </div>
            <dl className="m-0 flex flex-col gap-1 text-[14px] leading-5">
                <dt className={EYEBROW}>{t('cowork_panels.templates.task', 'Task')}</dt>
                <dd className="m-0 font-semibold text-[var(--text-primary)]">{shown.title}</dd>
                <dt className={`mt-1 ${EYEBROW}`}>{t('cowork_panels.templates.does', 'Does')}</dt>
                <dd className="m-0 whitespace-pre-wrap text-[var(--text-secondary)]">{shown.brief}</dd>
            </dl>
            {shown.plan && <MayDo permissions={shown.plan.permissions} t={t} />}
            <p className={`m-0 ${META}`}>{t('cowork_panels.templates.paused_note', 'It is added as a paused task and starts with a test. Nothing runs until you approve the steps.')}</p>
            <div className="flex flex-wrap gap-2">
                <PanelButton busy={add.isPending} onClick={() => add.mutate(pkg, { onSuccess: (used) => onOpenTask(used.item.id) })}>{t('cowork_panels.templates.add_paused', 'Add as a paused task')}</PanelButton>
                <PanelButton look="inline" disabled={add.isPending} onClick={onCancel}>{t('cowork_panels.cancel', 'Cancel')}</PanelButton>
            </div>
            <Problem error={add.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
        </div>
    );
}

function PackageSection({ onOpenTask }: { onOpenTask: (id: string) => void }) {
    const { t } = useTranslation();
    const preview = usePreviewPackage();
    const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
    const [unreadable, setUnreadable] = useState(false);
    const reset = () => { setPkg(null); setUnreadable(false); preview.reset(); };
    const read = async (file: File | undefined) => {
        reset();
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) { setUnreadable(true); return; }
        try {
            const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
            setPkg(parsed);
            preview.mutate(parsed);
        } catch {
            setUnreadable(true);
        }
    };
    return (
        <PanelSection section="import" title={t('cowork_panels.templates.file_heading', 'Add a task from a file')}>
            <div className={CARD}>
                <p className={BODY}>{t('cowork_panels.templates.package_intro', 'Got a task as a file from someone, from inside or outside your organisation? Add it here. Cowork checks who signed it before anything is added.')}</p>
                {!preview.data && (
                    <label className={`${BUTTON_SECONDARY} cursor-pointer self-start hover:bg-[var(--item-hover-bg)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]`}>
                        {t('cowork_panels.templates.choose_task_file', 'Choose a file')}
                        <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                )}
                {preview.isPending && <p role="status" className={`m-0 ${META}`}>{t('cowork_panels.templates.checking', 'Checking the signature…')}</p>}
                {unreadable && <p role="alert" className={ALERT}>{t('cowork_panels.templates.not_a_task_file', 'That file is not a task exported from Cowork.')}</p>}
                <Problem error={preview.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
                {preview.data && pkg && <PackagePreviewCard pkg={pkg} shown={preview.data} onOpenTask={onOpenTask} onCancel={reset} />}
            </div>
        </PanelSection>
    );
}

export default function CoworkTemplatesPanel({ open, fillComposer }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const guided = useContext(GuidedPanelContext);
    const list = useCoworkTemplates(true);
    const templates = list.data ?? [];
    return (
        <PanelShell testId="cowork-templates-panel" title={t('cowork_panels.templates.title', 'Start from a template')} meta={t('cowork_panels.templates.meta', 'Made by colleagues. You get your own copy, with your own apps.')}>
            <PanelOverview>{list.isPending && <PanelLoading />}{list.isSuccess && templates.length === 0 && <p className={`m-0 ${META}`}>{guided ? t('cowork_panels.templates.none_guided', 'No templates yet. Open a task and ask Bee to save it as a template.') : t('cowork_panels.templates.none_yet', 'Your organisation has no templates yet. Save one from a task’s People section.')}</p>}
            <PanelReadProblem error={list.error} retry={() => void list.refetch()} />
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {templates.map((tpl, i) => (
                    <li key={tpl.id} className={`${CARD} ${STAGGER(i)} flex-row items-center justify-between`} data-testid="cowork-panels-template">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[14px] leading-5 font-semibold text-[var(--text-primary)]">{tpl.title}</span>
                            <span className={`${META} whitespace-pre-wrap`}>{tpl.brief}</span>
                            {tpl.repeatInterval && <span className="text-[12px] leading-4 text-[var(--text-tertiary)]">{repeatLabel(tpl.repeatInterval, t)}</span>}
                        </div>
                        <PanelButton look="secondary" aria-label={t('cowork_panels.templates.use_named', 'Use “{title}”', { title: tpl.title })} onClick={() => guided ? fillComposer(tpl.brief, 'create') : fillComposer(tpl.brief)}>
                            {t('cowork_panels.templates.use', 'Use')}
                        </PanelButton>
                    </li>
                ))}
            </ul></PanelOverview>
            <PackageSection onOpenTask={(id) => open({ kind: 'task', id })} />
        </PanelShell>
    );
}
