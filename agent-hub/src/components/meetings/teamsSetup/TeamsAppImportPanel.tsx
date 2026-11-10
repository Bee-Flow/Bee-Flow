import { useId, useState } from 'react';
import { Building2, Loader2, Stethoscope } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import useConfirm from '@/components/shared/useConfirm';
import { isDiagnosticsRateLimited, useTeamsOrgOverview } from '@/api/queries/teamsSetup';
import {
    appImportErrorCode, useRunTeamsAppImportDiagnostics, useSaveTeamsAppImport, useTeamsAppImport,
} from '@/api/queries/teamsAppImport';
import { errorMessage } from '@/utils/caughtError';
import DiagnosticsChecklist from './DiagnosticsChecklist';
import { codeText, fixText, fixerText } from './checkText';
import type { AppImportBody, TeamsAppImportState, TeamsMemberRow } from './types';

/** The members list comes with the overview; the same window as its default shares the cache. */
const OVERVIEW_DAYS = 7;

const BOX = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';
const BADGE = 'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)]';
const BUTTON_SECONDARY = 'inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium border disabled:opacity-40 border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]';

type Availability = TeamsAppImportState['availability']['reason'];

/** Why organisation-wide import cannot be switched on: the result code and the fix for it (always the platform admin). */
const UNAVAILABLE: Partial<Record<Availability, { code: string; fix: string }>> = {
    instance_disabled: { code: 'app_import_disabled_instance', fix: 'teams_setup.fix.instance_disabled' },
    tenant_not_bound: { code: 'tenant_not_bound', fix: 'teams_setup.fix.bind_directory' },
    tenant_mismatch_sso: { code: 'tenant_mismatch_sso', fix: 'teams_setup.fix.bind_directory' },
    app_not_configured: { code: 'app_not_configured', fix: 'teams_setup.fix.configure_app_registration' },
};

const memberName = (m: TeamsMemberRow) => m.displayName || m.username || m.userId;

/** The words for a refused save; anything else shows the server's own message. */
function saveErrorText(t: TranslateFn, err: unknown): string | undefined {
    switch (appImportErrorCode(err)) {
        case 'app_import_unavailable': return t('teams_setup.app_import.error_unavailable');
        case 'not_a_member': return t('teams_setup.app_import.error_not_a_member');
        case 'too_many_selected': return t('teams_setup.app_import.error_too_many');
        default: return errorMessage(err);
    }
}

function UnavailableNotice({ reason }: { reason: Availability }) {
    const { t } = useTranslation();
    const why = UNAVAILABLE[reason];
    return (
        <div role="status" className="px-4 py-3 rounded-xl border text-[12px] border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,var(--bg-secondary))]">
            <p className="font-medium text-[var(--warning-ink)]">{t('teams_setup.app_import.unavailable')}</p>
            {why && (
                <>
                    <p className="mt-1 text-[var(--text-secondary)]">{codeText(t, why.code)}</p>
                    <p className="mt-1 text-[var(--text-primary)]">{fixText(t, why.fix)}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        <span className="font-medium">{t('teams_setup.ui.who_fixes')}:</span> {fixerText(t, 'platform_admin')}
                    </p>
                </>
            )}
        </div>
    );
}

interface MemberPickerProps {
    members: TeamsMemberRow[];
    selected: string[];
    disabled: boolean;
    onChange: (ids: string[]) => void;
}

/** Tick the members organisation-wide import covers. Ids not in the list (a cut-short overview) are kept. */
function MemberPicker({ members, selected, disabled, onChange }: MemberPickerProps) {
    const { t } = useTranslation();
    const chosen = new Set(selected);
    const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((s) => s !== id));
    return (
        <fieldset className={`${BOX} px-4 py-3`} disabled={disabled}>
            <legend className="px-1 text-[12px] font-medium text-[var(--text-primary)]">{t('teams_setup.app_import.select_members')}</legend>
            {members.length === 0 ? (
                <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.members.empty')}</p>
            ) : (
                <ul className="max-h-64 overflow-y-auto flex flex-col gap-1.5">
                    {members.map((m) => (
                        <li key={m.userId}>
                            <label className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-primary)]">
                                <input type="checkbox" checked={chosen.has(m.userId)} onChange={(e) => toggle(m.userId, e.target.checked)} />
                                <span>{memberName(m)}</span>
                                {!m.verifiedMicrosoftIdentity && <span className={BADGE}>{t('teams_setup.members.no_identity')}</span>}
                                {!m.meetingNotesAccess && <span className={BADGE}>{t('teams_setup.members.no_access')}</span>}
                            </label>
                        </li>
                    ))}
                </ul>
            )}
        </fieldset>
    );
}

function CoverageChoice({ value, disabled, onChange }: { value: AppImportBody['coverage']; disabled: boolean; onChange: (v: AppImportBody['coverage']) => void }) {
    const { t } = useTranslation();
    const name = useId();
    const option = (v: AppImportBody['coverage'], label: string) => (
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-primary)]">
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
            {label}
        </label>
    );
    return (
        <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1 text-[12px] font-medium text-[var(--text-primary)]">{t('teams_setup.app_import.coverage')}</legend>
            {option('all', t('teams_setup.app_import.coverage_all'))}
            {option('selected', t('teams_setup.app_import.coverage_selected'))}
        </fieldset>
    );
}

type SaveMessage = { type: 'success' | 'error'; text: string | undefined } | null;

function SaveRow({ busy, blocked, message, onSave }: { busy: boolean; blocked: boolean; message: SaveMessage; onSave: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3">
            <button
                type="button" onClick={onSave} disabled={busy || blocked}
                className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
            >
                {busy ? t('teams_setup.app_import.saving') : t('teams_setup.app_import.save')}
            </button>
            {message && (
                <span role={message.type === 'error' ? 'alert' : undefined} className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>
                    {message.text}
                </span>
            )}
        </div>
    );
}

interface AppImportFormProps {
    state: TeamsAppImportState;
    members: TeamsMemberRow[];
    /**
     * The organisation's automatic-import value: false = off for everyone, null = members
     * decide, undefined = not loaded yet (no hint then).
     */
    orgAutoImport: boolean | null | undefined;
}

/**
 * Why organisation-wide import alone may import nothing. The per-user default is off, and a
 * covered member who never connected cannot mark meetings (the Upcoming tab needs their own
 * connection), so unless the organisation switched automatic import on for everyone, or the
 * member did in their own settings, nothing is found for them.
 */
function AutoImportHint({ orgAutoImport }: { orgAutoImport: boolean | null | undefined }) {
    const { t } = useTranslation();
    if (orgAutoImport === false) return <p className="text-[12px] text-[var(--warning-ink)]">{t('teams_setup.app_import.auto_import_off_hint')}</p>;
    if (orgAutoImport === null) return <p className="text-[12px] text-[var(--warning-ink)]">{t('teams_setup.app_import.auto_import_members_decide_hint')}</p>;
    return null;
}

/** The settings: on/off, who is covered, the counts; switching on asks first. */
function AppImportForm({ state, members, orgAutoImport }: AppImportFormProps) {
    const { t } = useTranslation();
    const save = useSaveTeamsAppImport();
    const { confirm, confirmDialog } = useConfirm();
    const [draft, setDraft] = useState<AppImportBody | null>(null);
    const [message, setMessage] = useState<SaveMessage>(null);
    const { settings, availability, counts } = state;
    const form: AppImportBody = draft ?? { enabled: settings.enabled, coverage: settings.coverage, selectedUserIds: settings.selectedUserIds };
    const update = (patch: Partial<AppImportBody>) => { setMessage(null); setDraft({ ...form, ...patch }); };
    const available = availability.reason === 'ok';
    const busy = save.isPending;

    const onSave = async () => {
        setMessage(null);
        if (form.enabled && !settings.enabled) {
            const ok = await confirm({
                title: t('teams_setup.app_import.title'), description: t('teams_setup.app_import.confirm_enable'),
                confirmLabel: t('common.confirm'), cancelLabel: t('common.cancel'),
            });
            if (!ok) return;
        }
        try {
            await save.mutateAsync(form);
            setDraft(null);
            setMessage({ type: 'success', text: t('teams_setup.app_import.saved') });
        } catch (e) {
            setMessage({ type: 'error', text: saveErrorText(t, e) });
        }
    };

    return (
        <div className="flex flex-col gap-3">
            {!available && <UnavailableNotice reason={availability.reason} />}
            {available && availability.tenantId && (
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.app_import.tenant', { tenantId: availability.tenantId })}</p>
            )}
            <Toggle
                checked={form.enabled} onChange={(v) => update({ enabled: v })}
                // Switching off stays possible when the server can no longer offer it.
                disabled={busy || (!available && !form.enabled)}
                label={t('teams_setup.app_import.enable')} description={t('teams_setup.app_import.audit_note')}
            />
            {form.enabled && <AutoImportHint orgAutoImport={orgAutoImport} />}
            <CoverageChoice value={form.coverage} disabled={busy} onChange={(v) => update({ coverage: v })} />
            {form.coverage === 'selected' && (
                <MemberPicker members={members} selected={form.selectedUserIds} disabled={busy} onChange={(ids) => update({ selectedUserIds: ids })} />
            )}
            <p className="text-[12px] text-[var(--text-secondary)]" data-testid="teams-app-import-counts">{t('teams_setup.app_import.counts', { ...counts })}</p>
            <SaveRow busy={busy} blocked={form.enabled && !available} message={message} onSave={onSave} />
            {confirmDialog}
        </div>
    );
}

/** The option B checklist, run for one covered member (the caller by default on the server). */
function AppImportTest({ members }: { members: TeamsMemberRow[] }) {
    const { t } = useTranslation();
    const selectId = useId();
    const run = useRunTeamsAppImportDiagnostics();
    const covered = members.filter((m) => m.appImportCovered);
    const [probe, setProbe] = useState('');
    const probeUserId = covered.some((m) => m.userId === probe) ? probe : covered[0]?.userId;
    const busy = run.isPending;
    let error: string | null = null;
    if (run.isError) {
        if (isDiagnosticsRateLimited(run.error)) error = t('teams_setup.ui.rate_limited');
        else if (appImportErrorCode(run.error) === 'not_a_member') error = t('teams_setup.app_import.error_not_a_member');
        else error = t('teams_setup.ui.test_failed');
    }
    return (
        <div className="flex flex-col gap-3" data-testid="teams-app-import-test">
            <div className="flex flex-wrap items-center gap-3">
                {covered.length > 0 && (
                    <label htmlFor={selectId} className="flex items-center gap-2 text-[12px] text-[var(--text-primary)]">
                        {t('teams_setup.app_import.probe_user')}
                        <select
                            id={selectId} value={probeUserId} onChange={(e) => setProbe(e.target.value)} disabled={busy}
                            className="px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                        >
                            {covered.map((m) => <option key={m.userId} value={m.userId}>{memberName(m)}</option>)}
                        </select>
                    </label>
                )}
                <button type="button" onClick={() => run.mutate(probeUserId ? { probeUserId } : {})} disabled={busy} className={BUTTON_SECONDARY}>
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Stethoscope className="w-3.5 h-3.5" aria-hidden="true" />}
                    {busy ? t('teams_setup.ui.testing') : t('teams_setup.app_import.test')}
                </button>
                {error && <span role="alert" className="text-[12px] font-medium text-[var(--error-ink)]">{error}</span>}
            </div>
            {run.data && <DiagnosticsChecklist checks={run.data.checks} overall={run.data.overall} ranAt={run.data.ranAt} />}
        </div>
    );
}

/**
 * Option B for the organisation admin: import the Teams meetings of covered members with the
 * app's own (application) permissions, without each of them connecting
 * (/api/teams-setup/org/app-import). Off by default; the server decides whether it can be
 * switched on (tenant linked, app registration, instance switch) and who is covered. The
 * member list comes from the members overview, so nothing here asks Microsoft.
 */
export default function TeamsAppImportPanel() {
    const { t } = useTranslation();
    const state = useTeamsAppImport();
    const overview = useTeamsOrgOverview(OVERVIEW_DAYS);
    const members = overview.data?.members ?? [];

    return (
        <section className="flex flex-col gap-3" aria-labelledby="teams-app-import-title" data-testid="teams-app-import">
            <div>
                <h4 id="teams-app-import-title" className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                    <Building2 className="w-4 h-4 text-[var(--accent-secondary)]" aria-hidden="true" />
                    {t('teams_setup.app_import.title')}
                </h4>
                <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.app_import.intro')}</p>
            </div>
            {state.isLoading && (
                <div className={`flex items-center gap-2 px-4 py-3 ${BOX}`}>
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" aria-hidden="true" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading', 'Loading…')}</span>
                </div>
            )}
            {state.isError && <p className={`px-4 py-3 text-[13px] text-[var(--text-muted)] ${BOX}`}>{t('teams_setup.app_import.unavailable')}</p>}
            {state.data && (
                <>
                    <AppImportForm state={state.data} members={members} orgAutoImport={overview.data ? (overview.data.settings?.autoImport ?? null) : undefined} />
                    <AppImportTest members={members} />
                </>
            )}
        </section>
    );
}
