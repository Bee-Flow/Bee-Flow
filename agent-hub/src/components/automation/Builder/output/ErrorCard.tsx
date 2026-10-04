import { useState } from 'react';
import { AlertCircle, Lock, Plug, Share2 } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/** One way to fix a failed step, as the server's error classifier offers it. */
export interface ErrorFix {
    id: 'share_folder' | 'switch_account' | 'reconnect' | 'pick_other' | 'open_settings' | 'retry' | string;
    /** English, from the server: the fallback when no key translates it. */
    label?: string | null;
    /** 'automations.output.fix_*': the server's translation key for the label. */
    labelKey?: string | null;
    params?: Record<string, unknown> | null;
}

/** A run-step row's `errorInfo` (server: automation_run_steps.error_info). */
export interface StepErrorInfo {
    code?: string | null;
    title?: string | null;
    cause?: string | null;
    settingKey?: string | null;
    fixes?: ErrorFix[] | null;
    technical?: string | null;
    titleKey?: string | null;
    causeKey?: string | null;
    params?: Record<string, unknown> | null;
}

interface ErrorCardProps {
    info: StepErrorInfo | null;
    /** The raw error text on the row. */
    error: string | null;
    /** The older one-line hint the row may carry instead of `info`. */
    remediation?: string | null;
    onRetry?: (() => void) | null;
    /**
     * Fixes that change a setting (other account, pick another, open the
     * setting). Returning false means the setting could not be shown, and the
     * card explains in words which one to change instead.
     */
    onFix?: ((fix: ErrorFix, info: StepErrorInfo | null) => boolean | void) | null;
}

const PRIMARY = 'px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold inline-flex items-center gap-1.5 hover:opacity-90';
const SECONDARY = 'px-3 py-1.5 rounded-lg border border-[var(--border-default)] font-medium hover:bg-[var(--bg-secondary)]';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The label in the reader's language: the server's key, then the id, then its English text. */
function fixLabel(t: TranslateFn, fix: ErrorFix): string {
    const account = str(fix.params?.account);
    const byId = (): string | null => {
        switch (fix.id) {
        case 'share_folder':
            return account
                ? t('automations.output.fix_share_with', 'Share the folder with {account}', { account })
                : t('automations.output.fix_share', 'Share the folder');
        case 'switch_account': return t('automations.output.fix_switch_account', 'Other account');
        case 'reconnect': return t('automations.output.fix_reconnect', 'Reconnect');
        case 'pick_other': return t('automations.output.fix_pick_other', 'Pick another');
        case 'open_settings': return t('automations.output.fix_open_settings', 'Open the setting');
        case 'retry': return t('automations.output.fix_retry', 'Try again');
        default: return null;
        }
    };
    const key = str(fix.labelKey);
    if (key) return t(key, str(fix.label) || byId() || fix.id, { ...(fix.params || {}), account: account || '' });
    return byId() || str(fix.label) || fix.id;
}

/** Fixes that are answered by changing a setting in column 2. */
const SETTING_FIXES = new Set(['switch_account', 'pick_other', 'open_settings']);

/** The setting a fix points at, in words: 'inputs.path' reads as "path". */
function settingWords(t: TranslateFn, p: Record<string, unknown>, info: StepErrorInfo | null): string {
    const label = str(p.settingLabel);
    if (label) return label;
    const key = str(p.settingKey) || str(info?.settingKey);
    if (!key) return t('automations.output.fix_setting_generic', 'highlighted');
    if (key === 'connection') return t('automations.output.setting_connection', 'Connection');
    if (key === 'tool') return t('automations.output.setting_action', 'Action');
    if (key === 'modelTier') return t('automations.output.setting_model', 'Model');
    if (key === 'prompt') return t('automations.output.setting_prompt', 'Prompt');
    return key.replace(/^inputs\./, '');
}

function iconFor(info: StepErrorInfo | null) {
    const code = String(info?.code || '').toLowerCase();
    if (/(forbidden|permission|access|denied|share|not_shared|locked)/.test(code)) return Lock;
    if (/(auth|token|connect|credential|expired)/.test(code)) return Plug;
    return AlertCircle;
}

type FixAction =
    | { kind: 'open'; url: string }
    | { kind: 'retry' }
    | { kind: 'delegate' }
    | { kind: 'explain'; text: string };

/** What pressing a fix does, decided without touching anything. */
function fixAction(t: TranslateFn, fix: ErrorFix, info: StepErrorInfo | null, canDelegate: boolean): FixAction {
    const p = fix.params || {};
    if (fix.id === 'share_folder') {
        const url = str(p.shareUrl) || str(p.url);
        if (url) return { kind: 'open', url };
        const folder = str(p.folder) || str(p.path);
        const account = str(p.account) || t('automations.output.the_account', 'the account this step uses');
        return {
            kind: 'explain',
            text: folder
                ? t(
                    'automations.output.fix_share_explain',
                    'Open the folder {folder} in Nextcloud Files, choose Share, and share it with {account}. Then try the step again.',
                    { folder, account },
                )
                : t(
                    'automations.output.fix_share_explain_generic',
                    'Open the folder in Nextcloud Files, choose Share, and share it with {account}. Then try the step again.',
                    { account },
                ),
        };
    }
    if (fix.id === 'retry') return { kind: 'retry' };
    if (fix.id === 'reconnect') return { kind: 'open', url: '/app/settings/integrations' };
    if (canDelegate && SETTING_FIXES.has(fix.id)) return { kind: 'delegate' };
    return { kind: 'explain', text: settingExplain(t, p, info) };
}

function settingExplain(t: TranslateFn, p: Record<string, unknown>, info: StepErrorInfo | null): string {
    return t(
        'automations.output.fix_setting_explain',
        'Change the "{setting}" setting in column 2, then try again.',
        { setting: settingWords(t, p, info) },
    );
}

/** Title, cause and raw message, from the classification when there is one. */
function errorTexts(t: TranslateFn, info: StepErrorInfo | null, error: string | null, remediation: string | null) {
    const fallbackTitle = t('automations.output.error_title', 'This step stopped with an error');
    // Without a classification the row's own message is the only cause there
    // is; with one, the raw message moves behind "technical message".
    if (!info) return { title: fallbackTitle, cause: error || remediation, technical: null };
    const params = info.params || {};
    const title = (info.titleKey ? t(info.titleKey, info.title || '', params) : info.title) || fallbackTitle;
    const cause = (info.causeKey ? t(info.causeKey, info.cause || '', params) : info.cause) || remediation;
    return { title, cause, technical: str(info.technical) || str(error) };
}

/**
 * Why the step stopped, in plain words, with the button that fixes it
 * (artboard 4a): a title, the cause, the fixes the server offered, and the
 * raw message one click away for whoever needs it.
 */
export default function ErrorCard({ info, error, remediation = null, onRetry = null, onFix = null }: ErrorCardProps) {
    const { t } = useTranslation();
    const [showTech, setShowTech] = useState(false);
    const [explain, setExplain] = useState<string | null>(null);
    const { title, cause, technical } = errorTexts(t, info, error, remediation);
    const fixes = (info?.fixes || []).filter(f => f && f.id);
    const Icon = iconFor(info);

    const run = (fix: ErrorFix) => {
        setExplain(null);
        const action = fixAction(t, fix, info, !!onFix);
        if (action.kind === 'open') window.open(action.url, '_blank', 'noopener');
        else if (action.kind === 'explain') setExplain(action.text);
        else if (action.kind === 'delegate') {
            if (onFix?.(fix, info) === false) setExplain(settingExplain(t, fix.params || {}, info));
        }
        else if (onRetry) onRetry();
        else setExplain(t('automations.output.fix_retry_explain', 'Run the step again with Test step.'));
    };

    return (
        <div className="rounded-[10px] border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[var(--bg-card)] overflow-hidden text-xs" role="group" aria-label={title} data-testid="output-error-card">
            <div className="px-3.5 py-3 flex flex-col gap-1.5 bg-[color-mix(in_srgb,var(--error)_6%,transparent)]">
                <div className="flex items-center gap-2 font-semibold text-[13px] text-[var(--error)]">
                    <Icon size={14} aria-hidden className="shrink-0" />
                    <span>{title}</span>
                </div>
                {cause && <div className="text-[var(--text-secondary)] leading-[17px] whitespace-pre-wrap break-words">{cause}</div>}
            </div>
            {(fixes.length > 0 || technical) && (
                <div className="px-3.5 py-2.5 flex gap-1.5 flex-wrap items-center border-t border-[var(--border-default)]">
                    {fixes.map((f, i) => (
                        <button key={`${f.id}-${i}`} type="button" onClick={() => run(f)} className={i === 0 ? PRIMARY : SECONDARY}>
                            {i === 0 && f.id === 'share_folder' && <Share2 size={12} aria-hidden />}
                            {fixLabel(t, f)}
                        </button>
                    ))}
                    {technical && (
                        <button type="button" aria-expanded={showTech} onClick={() => setShowTech(v => !v)} className="ml-auto text-[var(--text-tertiary)] underline hover:text-[var(--text-primary)]">
                            {t('automations.output.technical_message', 'technical message')}
                        </button>
                    )}
                </div>
            )}
            {explain && <div className="px-3.5 pb-2.5 text-[var(--text-secondary)]" role="status">{explain}</div>}
            {showTech && technical && (
                <pre className="mx-3.5 mb-3 p-2 rounded-md bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-auto custom-scrollbar">{technical}</pre>
            )}
        </div>
    );
}
