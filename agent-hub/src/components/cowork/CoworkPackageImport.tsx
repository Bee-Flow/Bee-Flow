/**
 * "Add from a file": a Cowork package (server/usecases/coworkPackages.mts) read in from a file, under the templates
 * of the Cowork home (./CoworkTemplates.tsx). The server checks its signature first and works out what its plan may
 * do from the plan itself; the preview says who signed it, in plain words, before anything is added. Adding makes a
 * paused item whose plan waits for its owner's approval, as a template does.
 */
import { useState } from 'react';
import { FileUp } from 'lucide-react';
import { useAddPackage, usePreviewPackage, type PackagePreview } from '../../api/coworkTemplates';
import { useTranslation, type TranslateFn } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { MayDo } from './CoworkPlanCard';

const PRIMARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]';
const MAX_FILE_BYTES = 1_000_000;

/** Who signed the package, in plain words: this installation and which of its organisations, or another installation. */
function signedByText(signedBy: PackagePreview['signedBy'], t: TranslateFn): string {
    if (!signedBy.thisInstallation) {
        return t('cowork_templates.signed_elsewhere', 'Signed by another Bee Flow (key {key}), and unchanged since. Add it only if you know where it comes from.', { key: signedBy.keyId });
    }
    if (signedBy.organisation === 'your_organisation') return t('cowork_templates.signed_here', 'Signed by your organisation on this Bee Flow, and unchanged since.');
    if (signedBy.organisation === 'another_organisation') {
        return t('cowork_templates.signed_here_other_org', 'Signed on this Bee Flow by another organisation, not yours, and unchanged since. Add it only if you know where it comes from.');
    }
    return t('cowork_templates.signed_here_unknown_org', 'Signed on this Bee Flow, but the file does not say by which organisation. Add it only if you know where it comes from.');
}

export default function CoworkPackageImport({ onAdded }: { onAdded: (coworkId: string) => void }) {
    const { t } = useTranslation();
    const preview = usePreviewPackage();
    const add = useAddPackage();
    const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
    const [unreadable, setUnreadable] = useState(false);
    const read = async (file: File | undefined) => {
        setPkg(null); setUnreadable(false); preview.reset(); add.reset();
        if (!file || file.size > MAX_FILE_BYTES) { setUnreadable(!!file); return; }
        try {
            const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
            setPkg(parsed);
            preview.mutate(parsed);
        } catch {
            setUnreadable(true);
        }
    };
    const shown = preview.data;
    const failure = preview.error ?? add.error;
    return (
        <div className="flex flex-col gap-2 pt-2 border-t [border-color:var(--border-subtle)]" data-testid="cowork-package-import">
            <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] cursor-pointer">
                <FileUp aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_templates.import', 'Add from a file')}
                <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void read(e.target.files?.[0]); }} />
            </label>
            {unreadable && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{t('cowork_templates.import_unreadable', 'That file is not a Cowork package.')}</p>}
            {shown && pkg && (
                <div className="flex flex-col gap-2" data-testid="cowork-package-preview">
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{shown.title}</h3>
                    <span className="text-[12px] text-[var(--text-tertiary)]">
                        {signedByText(shown.signedBy, t)}
                    </span>
                    <p className="text-[12.5px] whitespace-pre-wrap text-[var(--text-secondary)]">{shown.brief}</p>
                    {shown.plan && <MayDo permissions={shown.plan.permissions} t={t} />}
                    <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_templates.adds_paused', 'Adding it runs nothing: it starts paused, and you approve its plan after a try-out.')}</p>
                    <div>
                        <button type="button" className={PRIMARY} disabled={add.isPending} onClick={() => add.mutate(pkg, { onSuccess: (used) => onAdded(used.item.id) })}>
                            {t('cowork_templates.add', 'Add to my cowork')}
                        </button>
                    </div>
                </div>
            )}
            {failure && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(failure) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}
