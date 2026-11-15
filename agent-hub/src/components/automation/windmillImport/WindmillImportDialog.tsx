import { useRef } from 'react';
import { Lock, Upload } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { useEntitlements } from '@/components/licensing/EntitlementsContext';
import useTranslation from '@/hooks/useTranslation';
import { FIELD, PRIMARY_BTN, SECONDARY_BTN } from '../Builder/settings/settingsUi';
import FlowPreviewCard from './FlowPreviewCard';
import ImportReportPanel from './ImportReportPanel';
import WindmillInventoryPanel from './WindmillInventoryPanel';
import useWindmillImport from './useWindmillImport';
import type { WindmillImportState } from './useWindmillImport';

interface Props {
    open: boolean;
    onClose: () => void;
    /** After a commit: the list re-reads. */
    onImported: () => void;
    /** Opens the AI builder on a draft with the briefing in its input box. */
    onCompleteWithAi: (automationId: string, brief: string) => void;
    onOpenAutomation: (automationId: string) => void;
}

/**
 * The import is a plan feature (`automation_import`, Enterprise). Only a real
 * answer locks: while the entitlements load (or failed) the dialog stays
 * usable and the server has the last word (403 feature_locked).
 */
function useImportLocked(): boolean {
    const { lockReason, loading, error } = useEntitlements();
    if (loading || error || typeof lockReason !== 'function') return false;
    return lockReason('automation_import') != null;
}

function UpgradeHint() {
    const { t } = useTranslation();
    return (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-[12px]">
            <Lock size={14} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
            <div>
                <p className="font-semibold text-[var(--text-primary)]">{t('automation_import.upgrade_title', 'Importing from Windmill is part of the Enterprise plan')}</p>
                <p className="mt-1 text-[var(--text-secondary)]">{t('automation_import.upgrade_body', 'Ask your administrator to upgrade the licence. Building automations yourself stays available on every plan.')}</p>
            </div>
        </div>
    );
}

function SourcePicker({ s }: { s: WindmillImportState }) {
    const { t } = useTranslation();
    const fileRef = useRef<HTMLInputElement | null>(null);
    const tab = (id: 'upload' | 'remote', label: string) => (
        <button
            type="button"
            role="tab"
            aria-selected={s.source === id}
            onClick={() => s.setSource(id)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium ${s.source === id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
        >
            {label}
        </button>
    );
    return (
        <div className="space-y-3">
            <div role="tablist" className="flex gap-1">
                {tab('upload', t('automation_import.source_upload', 'Upload an export'))}
                {tab('remote', t('automation_import.source_remote', 'Read from a Windmill'))}
            </div>
            {s.source === 'upload' ? (
                <div className="space-y-2 text-[12px]">
                    <p className="text-[var(--text-secondary)]">
                        {t('automation_import.upload_help', 'Upload a zip of `wmill sync pull --include-schedules --include-triggers --skip-resources`, or one flow as JSON or YAML. Secrets are never imported.')}
                    </p>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".zip,.json,.yaml,.yml,application/zip,application/json"
                        className="hidden"
                        aria-label={t('automation_import.choose_file', 'Choose a file')}
                        onChange={(e) => { s.setFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
                    />
                    <button type="button" className={SECONDARY_BTN} onClick={() => fileRef.current?.click()}>
                        <Upload size={13} />
                        {s.file ? s.file.name : t('automation_import.choose_file', 'Choose a file')}
                    </button>
                </div>
            ) : (
                <div className="space-y-2 text-[12px]">
                    <p className="text-[var(--text-secondary)]">
                        {t('automation_import.remote_help', 'Create a read-only token for one workspace in Windmill (Account settings → Tokens, read only, short expiry). It is used for this import only and never stored.')}
                    </p>
                    <label className="block">
                        <span className="text-[var(--text-secondary)]">{t('automation_import.remote_url', 'Windmill address (https://)')}</span>
                        <input className={FIELD} type="url" value={s.remote.baseUrl} onChange={(e) => s.setRemote({ ...s.remote, baseUrl: e.target.value })} />
                    </label>
                    <label className="block">
                        <span className="text-[var(--text-secondary)]">{t('automation_import.remote_workspace', 'Workspace id')}</span>
                        <input className={FIELD} value={s.remote.workspace} onChange={(e) => s.setRemote({ ...s.remote, workspace: e.target.value })} />
                    </label>
                    <label className="block">
                        <span className="text-[var(--text-secondary)]">{t('automation_import.remote_token', 'Read-only token')}</span>
                        <input className={FIELD} type="password" autoComplete="off" value={s.remote.token} onChange={(e) => s.setRemote({ ...s.remote, token: e.target.value })} />
                    </label>
                </div>
            )}
        </div>
    );
}

function Preview({ s }: { s: WindmillImportState }) {
    const { t } = useTranslation();
    const p = s.preview;
    if (!p) return null;
    return (
        <div className="space-y-2">
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('automation_import.preview_intro', '{count} flows found. Each becomes an inactive draft with an import report; nothing runs until you switch it on.', { count: p.flows.length })}
            </p>
            <ul className="space-y-2">
                {p.flows.map((f) => (
                    <FlowPreviewCard key={f.path} flow={f} selected={s.selected.has(f.path)} onToggle={() => s.toggle(f.path)} disabled={s.committing} />
                ))}
            </ul>
            {[...p.notes, ...p.readWarnings, ...p.notMigrated].length > 0 && (
                <details className="text-[11px] text-[var(--text-secondary)]">
                    <summary className="cursor-pointer">{t('automation_import.not_migrated', 'Not carried over')}</summary>
                    <ul className="mt-1 list-disc pl-5 space-y-0.5">
                        {[...p.notes, ...p.readWarnings, ...p.notMigrated].map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                </details>
            )}
        </div>
    );
}

function Results({ s, onCompleteWithAi, onOpenAutomation }: { s: WindmillImportState } & Pick<Props, 'onCompleteWithAi' | 'onOpenAutomation'>) {
    const { t } = useTranslation();
    if (!s.results) return null;
    return (
        <div className="space-y-2">
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('automation_import.results_intro', 'Imported as inactive drafts. Switch each one off in Windmill once it runs here, or every event runs twice.')}
            </p>
            <ul className="space-y-2">
                {s.results.map((r) => (
                    <li key={r.path} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-3 text-[12px]">
                        <div className="font-semibold text-[var(--text-primary)] break-words">{r.title}</div>
                        {r.ok && r.automationId ? (
                            <ImportReportPanel automationId={r.automationId} onCompleteWithAi={onCompleteWithAi} onOpen={onOpenAutomation} />
                        ) : (
                            <p className="text-[11px] text-[var(--error-ink)]">{r.error || t('automation_import.flow_failed', 'This flow could not be imported.')}</p>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

type Step = 'source' | 'preview' | 'results';

function DialogFooter({ s, step, onClose }: { s: WindmillImportState; step: Step; onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY_BTN} onClick={onClose}>{step === 'results' ? t('automation_import.done', 'Done') : t('automation_import.cancel', 'Cancel')}</button>
            {step === 'source' && (
                <button type="button" className={PRIMARY_BTN} disabled={!s.canPreview || s.previewing} onClick={s.runPreview}>
                    {s.previewing ? t('automation_import.reading', 'Reading…') : t('automation_import.preview', 'Preview')}
                </button>
            )}
            {step === 'preview' && (
                <button type="button" className={PRIMARY_BTN} disabled={s.selected.size === 0 || s.committing} onClick={() => s.runCommit()}>
                    {s.committing ? t('automation_import.importing', 'Importing…') : t('automation_import.import_selected', 'Import {count} flows', { count: s.selected.size })}
                </button>
            )}
        </div>
    );
}

/**
 * "Import from Windmill": pick a source (an uploaded export, or a standalone
 * Windmill read once with a read-only token), preview what converts, select
 * the flows, import them as inactive drafts, and finish each one in the AI
 * builder. An Enterprise feature: without it the dialog says so.
 */
export default function WindmillImportDialog({ open, onClose, onImported, onCompleteWithAi, onOpenAutomation }: Props) {
    const { t } = useTranslation();
    const s = useWindmillImport({ onCommitted: onImported });
    const locked = useImportLocked();
    const close = () => { s.reset(); onClose(); };
    const step: Step = s.results ? 'results' : s.preview ? 'preview' : 'source';
    const footer = locked ? null : <DialogFooter s={s} step={step} onClose={close} />;
    return (
        <Modal open={open} onClose={close} title={t('automation_import.title', 'Import from Windmill')} size="lg" footer={footer}>
            {locked ? <UpgradeHint /> : (
                <div className="space-y-4">
                    {step === 'source' && <WindmillInventoryPanel />}
                    {step === 'source' && <SourcePicker s={s} />}
                    {step === 'preview' && <Preview s={s} />}
                    {step === 'results' && <Results s={s} onCompleteWithAi={(id, brief) => { s.reset(); onCompleteWithAi(id, brief); }} onOpenAutomation={(id) => { s.reset(); onOpenAutomation(id); }} />}
                    {s.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{s.error.message}</p>}
                </div>
            )}
        </Modal>
    );
}
