/**
 * Templates, from the Cowork user menu (opens in the right-side sheet): what colleagues saved for the organisation
 * (GET /api/cowork/templates), each with "Use", which hands its sentence to the composer on Home; and "Add a package
 * file": a task as a signed file. The server checks the signature first (POST /api/cowork/packages/preview) and the
 * panel says who signed it before "Add as a paused task" (POST /api/cowork/packages/add) makes anything; the new task
 * then opens through `onOpenTask`. Adding runs nothing.
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAddPackage, useCoworkTemplates, usePreviewPackage, type PackagePreview } from '@/api/coworkTemplates';
import { Button } from '@/components/shared/Button';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { MayDo } from '../CoworkPlanCard';
import { repeatLabel } from '../coworkSchedule';
import { CARD, META, PanelSection, PanelShell, Problem, TALL } from './panelParts';

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
            <div className="flex items-start gap-2 text-[13.5px] text-[var(--text-primary)]" role="status">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                    {t('cowork_panels.templates.signature_checked', 'Signature checked.')} {signerText(shown.signedBy, t)} {t('cowork_panels.templates.unchanged', 'Nothing was changed since it was signed.')}
                    {!known && ` ${t('cowork_panels.templates.only_if_known', 'Add it only if you know where it comes from.')}`}
                </span>
            </div>
            <dl className="m-0 flex flex-col gap-1 text-[13px]">
                <dt className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('cowork_panels.templates.task', 'Task')}</dt>
                <dd className="m-0 font-semibold text-[var(--text-primary)]">{shown.title}</dd>
                <dt className="mt-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('cowork_panels.templates.does', 'Does')}</dt>
                <dd className="m-0 whitespace-pre-wrap text-[var(--text-secondary)]">{shown.brief}</dd>
            </dl>
            {shown.plan && <MayDo permissions={shown.plan.permissions} t={t} />}
            <p className={`m-0 ${META}`}>{t('cowork_panels.templates.paused_note', 'It is added as a paused task and starts with a test. Nothing runs until you approve the steps.')}</p>
            <div className="flex flex-wrap gap-2">
                <Button className={TALL} busy={add.isPending} onClick={() => add.mutate(pkg, { onSuccess: (used) => onOpenTask(used.item.id) })}>{t('cowork_panels.templates.add_paused', 'Add as a paused task')}</Button>
                <Button variant="ghost" className={TALL} onClick={onCancel}>{t('cowork_panels.cancel', 'Cancel')}</Button>
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
        <PanelSection title={t('cowork_panels.templates.package_heading', 'Add a package file')}>
            <div className={CARD}>
                <p className="m-0 text-[13.5px] text-[var(--text-primary)]">{t('cowork_panels.templates.package_intro', 'Got a task as a file from someone, from inside or outside your organisation? Add it here. Cowork checks who signed it before anything is added.')}</p>
                {!preview.data && (
                    <label className={`inline-flex ${TALL} cursor-pointer items-center self-start rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3.5 text-[13px] font-semibold text-[var(--text-primary)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]`}>
                        {t('cowork_panels.templates.choose_file', 'Choose a package file')}
                        <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                )}
                {preview.isPending && <p role="status" className={`m-0 ${META}`}>{t('cowork_panels.templates.checking', 'Checking the signature…')}</p>}
                {unreadable && <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{t('cowork_panels.templates.unreadable', 'That file is not a package from Cowork.')}</p>}
                <Problem error={preview.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
                {preview.data && pkg && <PackagePreviewCard pkg={pkg} shown={preview.data} onOpenTask={onOpenTask} onCancel={reset} />}
            </div>
        </PanelSection>
    );
}

export default function CoworkTemplatesPanel({ close, open, fillComposer }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const list = useCoworkTemplates(true);
    const templates = list.data ?? [];
    return (
        <PanelShell testId="cowork-templates-panel" title={t('cowork_panels.templates.title', 'Start from a template')} meta={t('cowork_panels.templates.meta', 'Made by colleagues. You get your own copy, with your own apps.')} onClose={close}>
            {list.isSuccess && templates.length === 0 && <p className={`m-0 ${META}`}>{t('cowork_panels.templates.empty', 'Your organisation has no templates yet. Save one from the settings of a task.')}</p>}
            <Problem error={list.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {templates.map((tpl) => (
                    <li key={tpl.id} className={`${CARD} flex-row items-center justify-between`} data-testid="cowork-panels-template">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[14px] font-semibold text-[var(--text-primary)]">{tpl.title}</span>
                            <span className={`${META} whitespace-pre-wrap`}>{tpl.brief}</span>
                            {tpl.repeatInterval && <span className="text-[12px] text-[var(--text-tertiary)]">{repeatLabel(tpl.repeatInterval, t)}</span>}
                        </div>
                        <Button variant="secondary" className={TALL} aria-label={t('cowork_panels.templates.use_named', 'Use “{title}”', { title: tpl.title })} onClick={() => fillComposer(tpl.brief)}>
                            {t('cowork_panels.templates.use', 'Use')}
                        </Button>
                    </li>
                ))}
            </ul>
            <PackageSection onOpenTask={(id) => open({ kind: 'task', id })} />
        </PanelShell>
    );
}
