// Organisation settings › AI context › "Images to AI in automations": whether
// an AI step or a data extraction in an automation may show the picture
// itself to the model, or only the text read from it. Off by default; only
// an admin of the organisation changes it. Turning it on asks first, because
// the pictures then reach the model provider and the Privacy Shield cannot
// check pixels.

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useOrgAutomationImageAi, useSaveOrgAutomationImageAi, type OrgImageAiSetting } from '@/api/queries/orgAutomationImageAi';
import { useTranslation } from '@/hooks/useTranslation';
import ConfirmDialog from '../../shared/ConfirmDialog';
import Toggle from '../../shared/Toggle';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR } from '@/components/shared/adminUi';
import { errorStatus } from '@/utils/caughtError';

function Switch({ orgId, server }: { orgId: string; server: OrgImageAiSetting }) {
    const { t } = useTranslation();
    const save = useSaveOrgAutomationImageAi(orgId);
    const [confirmOn, setConfirmOn] = useState(false);
    const [status, setStatus] = useState<'saved' | 'failed' | 'forbidden' | null>(null);
    const busy = save.isPending;

    const apply = (next: boolean) => new Promise<void>((resolve) => {
        setStatus(null);
        save.mutate(next, {
            onSuccess: () => { setStatus('saved'); resolve(); },
            onError: (e) => { setStatus(errorStatus(e) === 403 ? 'forbidden' : 'failed'); resolve(); },
        });
    });
    const onChange = (next: boolean) => {
        if (!next) { void apply(false); return; }
        setConfirmOn(true);
    };

    return (
        <div className="space-y-3">
            <SettingsList>
                <Toggle flat checked={server.enabled} disabled={busy} onChange={onChange}
                    label={t('automation_image_ai.toggle', 'Let automations show images to AI')}
                    description={t('automation_image_ai.toggle_desc', 'An AI step or a data extraction may show a picture (a receipt, a photo of a document) to a model that reads images. When this is off, the step gets the text read from the image instead.')} />
            </SettingsList>
            <ul className="m-0 list-disc space-y-1 pl-5 text-xs text-[var(--text-secondary)]">
                <li>{t('automation_image_ai.rule_shield', 'When the Privacy Shield applies to an automation, its images are never sent: the shield cannot check pictures for personal data, so the step uses the text read from them.')}</li>
                <li>{t('automation_image_ai.rule_model', 'Only models that read images get them; other models get the text.')}</li>
                <li>{t('automation_image_ai.rule_dry_run', 'A test run never sends images.')}</li>
            </ul>
            <div className="min-h-[1.25rem] flex items-center gap-2 text-sm">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-secondary)]" aria-hidden="true" />}
                {status === 'saved' && <span role="status" className="text-[var(--text-secondary)]">{t('automation_image_ai.saved', 'Saved.')}</span>}
                {status === 'failed' && <span role="alert" className="text-[var(--error-ink)]">{t('automation_image_ai.save_failed', 'Could not save this setting. Try again.')}</span>}
                {status === 'forbidden' && <span role="alert" className="text-[var(--error-ink)]">{t('automation_image_ai.forbidden', 'Only an admin of this organisation can change this.')}</span>}
            </div>
            <ConfirmDialog
                open={confirmOn}
                title={t('automation_image_ai.on_title', 'Show images to AI in automations?')}
                description={t('automation_image_ai.on_desc', 'Pictures that automations read (receipts, photos, scans) are then sent to the AI model provider your organisation uses. They are not stored by Bee Flow, but they cannot be checked for personal data first.')}
                confirmLabel={t('automation_image_ai.on_confirm', 'Switch on')}
                cancelLabel={t('automation_image_ai.cancel', 'Cancel')}
                onConfirm={async () => { await apply(true); setConfirmOn(false); }}
                onCancel={() => setConfirmOn(false)}
            />
        </div>
    );
}

export default function OrgAutomationImageAiEditor({ orgId }: { orgId: string | null | undefined }) {
    const { t } = useTranslation();
    const query = useOrgAutomationImageAi(orgId);
    if (!orgId) return null;
    // The same SettingsGroup (an h3 title, a one-line description) as the answer-reuse
    // editor above it on the Automations page: the page frame draws the page's h2.
    return (
        <div data-testid="org-automation-image-ai">
            <SettingsGroup
                title={t('automation_image_ai.title', 'Images to AI in automations')}
                description={t('automation_image_ai.intro', 'Whether automations may show pictures to an AI model, or only the text read from them.')}
            >
                {query.isPending && (
                    <div className="flex items-center gap-2 p-2 text-sm text-[var(--text-secondary)]" role="status">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('automation_image_ai.loading', 'Loading…')}
                    </div>
                )}
                {query.isError && (
                    <div className={ALERT_ERROR} role="alert">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                        <span className="flex-1">{t('automation_image_ai.load_failed', 'Could not load this setting.')}</span>
                        <button type="button" onClick={() => query.refetch()} className="underline">{t('automation_image_ai.retry', 'Try again')}</button>
                    </div>
                )}
                {query.data && <Switch key={orgId} orgId={orgId} server={query.data} />}
            </SettingsGroup>
        </div>
    );
}
