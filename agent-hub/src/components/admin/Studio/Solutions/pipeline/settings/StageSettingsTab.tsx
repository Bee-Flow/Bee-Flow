import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { useLicenseContext } from '../../../../../licensing/LicenseContext';
import Button from '../../../../../shared/Button';
import DeployDialog from '../DeployDialog';
import { useStageLabel } from '../StageSwitcher';
import type { ApiResult, PipelineStage, StageKey } from '../stagesApi';
import AccessSection from './AccessSection';
import AddressesSection from './AddressesSection';
import BindingsSection from './BindingsSection';
import DangerZone from './DangerZone';
import GateSection from './GateSection';
import LoadWarning from './LoadWarning';
import PartsSection from './PartsSection';
import { cleanBindingValue } from './seatShapes';
import * as api from './stageSettingsApi';
import {
    applyNeedsApproval, canOperate, gateOutcome, isOwnerRole, settingsError, valueFromInput,
    type Draft, type GateOutcome, type Requirement, type SettingsError, type StageSettings,
} from './stageSettingsModel';
import SettingsBlock from './SettingsBlock';
import SettingsNav, { type SettingsNavItem } from './SettingsNav';
import VariablesSection from './VariablesSection';

/**
 * The Settings tab of a UAT or Production stage (design 4 and 9): how the stage
 * is wired (bindings), the values of its variables, where it can be reached, who
 * may operate it, its parts on and off, the Production approval gate, and the
 * danger zone.
 *
 * Every read is its own state, so one that fails says so where it failed and
 * never reads as "empty" (unknown is not empty). PATCH of the stage and PUT of the
 * bindings carry `settingsVersion`; a 409 `settings_stale` shows a notice, reloads
 * the page's data and KEEPS the edits, so the person can check and save again.
 */

export interface StageSettingsTabProps {
    solutionId: string;
    solutionName: string;
    stage: StageKey;
    stageRow: PipelineStage | undefined;
    currentUserId?: string | null;
    /** The pipeline read is stale (a flag, a release, the stage itself changed). */
    onChanged: () => void;
}

type Load = 'loading' | 'ok' | 'error' | 'no_access';
interface Loaded<T> { load: Load; code: string | null; data: T | null; setData: React.Dispatch<React.SetStateAction<T | null>>; reload: () => void }

/** One read: the first answer shows a spinner, a re-read keeps what is on screen until the new answer lands. */
function useLoaded<T>(key: string, enabled: boolean, fetcher: () => Promise<ApiResult<T>>): Loaded<T> {
    const [state, setState] = useState<{ load: Load; code: string | null }>({ load: 'loading', code: null });
    const [data, setData] = useState<T | null>(null);
    const [epoch, setEpoch] = useState(0);
    const latest = useRef(fetcher);
    useEffect(() => { latest.current = fetcher; });
    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        (async () => {
            const res = await latest.current();
            if (!alive) return;
            if (res.ok) { setData(res.data); setState({ load: 'ok', code: null }); return; }
            setState({ load: res.status === 403 ? 'no_access' : 'error', code: res.code });
        })();
        return () => { alive = false; };
    }, [key, enabled, epoch]);
    const reload = useCallback(() => setEpoch(n => n + 1), []);
    return { ...state, data, setData, reload };
}

type T = ReturnType<typeof useTranslation>['t'];
type Fail = Extract<ApiResult<unknown>, { ok: false }>;

/** What every write hook needs: where to write, what to reload afterwards, and where a failure goes. */
interface Ctx {
    solutionId: string;
    stage: StageKey;
    settings: Loaded<StageSettings>;
    reqs: { reload: () => void };
    vars: Loaded<api.VariablesRead>;
    onChanged: () => void;
    fail: (res: Fail) => SettingsError;
    flag: (key: string, on: boolean) => void;
    setNotice: (n: SettingsError | null) => void;
    t: T;
}

function useBindingWrites(c: Ctx) {
    const [draft, setDraft] = useState<Draft>({});
    const [slotErrors, setSlotErrors] = useState<Record<string, string>>({});
    const onDraft = (slot: string, value: unknown | undefined) => {
        setSlotErrors({});
        setDraft(d => { const rest = { ...d }; delete rest[slot]; return value === undefined ? rest : { ...rest, [slot]: value }; });
    };
    const discard = () => { setDraft({}); setSlotErrors({}); };
    const save = async () => {
        const s = c.settings.data;
        if (!s) return;
        c.setNotice(null); setSlotErrors({}); c.flag('bindings', true);
        const res = await api.putBindings(c.solutionId, c.stage, s.settingsVersion, Object.entries(draft).map(([slot, value]) => ({ slot, value: cleanBindingValue(value) })));
        c.flag('bindings', false);
        if (res.ok) {
            setDraft({});
            c.settings.setData(cur => (cur ? { ...cur, settingsVersion: res.data.settingsVersion ?? cur.settingsVersion, bindingsPending: true } : cur));
            c.reqs.reload(); c.onChanged();
            return;
        }
        const err = c.fail(res);
        if (err.kind === 'binding_invalid' && err.slot) { c.setNotice(null); setSlotErrors({ [err.slot]: err.why || 'invalid_value' }); }
    };
    return { draft, slotErrors, onDraft, discard, save };
}

function useValueWrites(c: Ctx) {
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const onDraft = (name: string, text: string | undefined) =>
        setDraft(d => { const rest = { ...d }; delete rest[name]; return text === undefined ? rest : { ...rest, [name]: text }; });
    const save = async () => {
        c.setNotice(null); setErrors({}); c.flag('values', true);
        const values: Record<string, string | number | boolean | null> = {};
        for (const [name, text] of Object.entries(draft)) {
            const decl = c.vars.data?.decls.find(d => d.name === name);
            if (decl) values[name] = valueFromInput(decl, text);
        }
        const res = await api.putValues(c.solutionId, c.stage, values);
        c.flag('values', false);
        if (res.ok) { setDraft({}); c.vars.reload(); c.settings.reload(); c.onChanged(); return; }
        const err = c.fail(res);
        if ((err.kind === 'variable' || err.kind === 'steering_owner_only') && err.name) {
            c.setNotice(null);
            setErrors({ [err.name]: err.kind === 'variable'
                ? c.t('stage_settings.vars_invalid', 'This value does not fit the type of the variable.')
                : c.t('stage_settings.vars_owner_only', 'Only the owner of this Solution can change this value: it decides where data or mail goes.') });
        }
    };
    return { draft, errors, onDraft, save };
}

function usePartWrites(c: Ctx) {
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [pauseNotice, setPauseNotice] = useState<string | null>(null);
    const partText = (res: Fail): string => {
        const err = settingsError(res);
        if (err.kind === 'not_deployed') return c.t('stage_settings.part_not_deployed', 'This part has not been deployed to this stage yet, so there is nothing to switch.');
        if (err.kind === 'forbidden') return c.t('stage_settings.part_forbidden', 'You are not allowed to switch this part.');
        // A part's own gate (an automation that cannot go live) answers in its own words.
        return res.message && res.message !== 'feature_locked' ? res.message : c.t('stage_settings.part_failed', 'The part was not switched. Nothing changed.');
    };
    const switchPart = async (ref: string, active: boolean) => {
        c.flag(ref, true); setErrors(e => ({ ...e, [ref]: '' }));
        const res = await api.patchPart(c.solutionId, c.stage, ref, active);
        c.flag(ref, false);
        if (res.ok) { c.settings.setData(cur => (cur ? { ...cur, parts: cur.parts.map(x => (x.ref === ref ? { ...x, active } : x)) } : cur)); c.onChanged(); return; }
        setErrors(e => ({ ...e, [ref]: partText(res) }));
    };
    const pause = async (doPause: boolean) => {
        c.flag('pause', true); setPauseNotice(null);
        const res = await api.pauseStage(c.solutionId, c.stage, doPause);
        c.flag('pause', false);
        if (!res.ok) { c.fail(res); return; }
        if (res.data.failed?.length) setPauseNotice(c.t('stage_settings.pause_failed', '{n} automation(s) could not be switched. They are still listed as paused work; try again.', { n: res.data.failed.length }));
        c.settings.reload(); c.onChanged();
    };
    return { errors, pauseNotice, switchPart, pause };
}

function useGateWrites(c: Ctx) {
    const [gate, setGate] = useState<{ outcome: GateOutcome | null; error: SettingsError | null; epoch: number }>({ outcome: null, error: null, epoch: 0 });
    const patch = async (body: api.GatePatch) => {
        const s = c.settings.data;
        if (!s) return;
        c.setNotice(null); c.flag('stage', true);
        const res = await api.patchStage(c.solutionId, c.stage, s.settingsVersion, body);
        c.flag('stage', false);
        if (res.ok) {
            // 202: the change is a deployment the approvers decide; what is stored has not changed.
            const requested = gateOutcome(res.status) === 'approval_requested';
            const view = requested && res.data && typeof res.data === 'object' ? (res.data as { settings?: unknown }).settings : res.data;
            c.settings.setData(cur => (cur ? api.mergeSettings(cur, view) : cur));
            setGate(g => ({ outcome: gateOutcome(res.status), error: null, epoch: g.epoch + 1 }));
            c.onChanged();
            return;
        }
        const err = c.fail(res);
        if (err.kind === 'licence' || err.kind === 'policy_needs_approver') c.setNotice(null);   // the gate says it in its own words
        if (err.kind !== 'stale') setGate(g => ({ ...g, error: err, outcome: null }));
    };
    return { gate, patch };
}

type Removal = 'detached' | 'removal_started' | 'removal_requested' | null;

function useRemoval(c: Ctx) {
    const [danger, setDanger] = useState<{ error: string | null; result: Removal }>({ error: null, result: null });
    const failText = (res: Fail): string => {
        const err = settingsError(res);
        if (res.code === 'confirm_mismatch') return c.t('stage_settings.danger_mismatch', 'The name you typed is not the name of this Solution.');
        if (res.code === 'stage_busy') return c.t('stage_settings.danger_busy', 'Another deployment is running in this stage. Wait for it to finish.');
        if (err.kind === 'licence') return c.t('stage_settings.danger_licence', 'Your plan does not include release pipelines, so only detaching is possible.');
        if (err.kind === 'network') return c.t('stage_settings.err_network', 'The request did not arrive. Check your connection and try again.');
        return c.t('stage_settings.danger_failed', 'That did not work. Nothing was changed.');
    };
    const remove = async (input: { mode: 'detach' | 'delete'; confirm: string; deleteData: boolean }) => {
        c.flag('danger', true); setDanger({ error: null, result: null });
        const res = await api.removeStage(c.solutionId, c.stage, input.mode === 'delete' ? { confirm: input.confirm, mode: 'delete', deleteData: input.deleteData } : { confirm: input.confirm, mode: 'detach' });
        c.flag('danger', false);
        if (!res.ok) { setDanger({ result: null, error: failText(res) }); return; }
        const result: Removal = res.data.detached ? 'detached' : res.data.deployment?.status === 'awaiting_approval' ? 'removal_requested' : 'removal_started';
        setDanger({ error: null, result });
        if (result !== 'detached') c.onChanged();      // a detached stage is left through the button below
    };
    return { danger, remove };
}

function PendingBanner({ canApply, hasRelease, gateOn, onApply }: { canApply: boolean; hasRelease: boolean; gateOn: boolean; onApply: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 rounded-lg bg-[var(--bg-secondary)]" data-testid="settings-pending">
            <p className="text-sm text-[var(--text-primary)]">{t('stage_settings.pending', 'Settings changed since the last deploy. They apply when this stage is deployed again.')}</p>
            {!hasRelease && <p className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.apply_nothing', 'Nothing is deployed here yet; they apply with the first deployment.')}</p>}
            {hasRelease && canApply && (
                <div className="text-right">
                    <Button size="sm" onClick={onApply} data-testid="apply-settings">{t('stage_settings.apply', 'Apply settings')}</Button>
                    {gateOn && <p className="text-[11px] text-[var(--text-secondary)] mt-1" data-testid="apply-needs-approval">{t('stage_settings.apply_needs_approval', 'Production approval is on: this asks the approvers first.')}</p>}
                </div>
            )}
        </div>
    );
}

function useNoticeText(): (n: SettingsError) => string {
    const { t } = useTranslation();
    return (n) => ({
        stale: t('stage_settings.notice_stale', 'These settings were changed by someone else while you were editing. The latest values are loaded; your edits are still here. Check them and save again.'),
        network: t('stage_settings.err_network', 'The request did not arrive. Check your connection and try again.'),
        forbidden: t('stage_settings.err_forbidden', 'You are not allowed to do this.'),
        licence: t('stage_settings.err_licence', 'Your plan does not include release pipelines.'),
    } as Record<string, string>)[n.kind] || t('stage_settings.err_unknown', 'That did not work. Nothing was changed.');
}

function Unreadable({ code, onRetry }: { code: string | null; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]" data-testid="stage-settings-unreadable">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
            {code === 'no_access' ? t('stage_settings.no_access', 'You are not allowed to see the settings of this stage.') : t('stage_settings.unreadable', 'The settings of this stage could not be read, so nothing is shown rather than something wrong.')}
            {code !== 'no_access' && <button type="button" className="underline" onClick={onRetry}>{t('stage_settings.retry', 'Try again')}</button>}
        </p>
    );
}

/** The reads of the page: the stage, what it needs, its variables, and the people and connections the pickers offer. */
function useReads(solutionId: string, stage: StageKey, stageRole: string | undefined) {
    const settings = useLoaded(`${solutionId}:${stage}:s`, true, () => api.getSettings(solutionId, stage));
    const role = settings.data?.role || stageRole || '';
    const owner = isOwnerRole(role);
    const operate = canOperate(role);
    const releaseId = settings.data?.currentRelease?.id ?? null;
    return {
        settings, role, owner, operate,
        // Asked for the release the stage runs now, so "Missing" never names a slot only an unpromoted release needs.
        reqs: useLoaded(`${solutionId}:${stage}:r:${releaseId ?? ''}`, operate && !!settings.data, () => api.getRequirements(solutionId, stage, releaseId)),
        vars: useLoaded(`${solutionId}:${stage}:v`, true, () => api.getVariables(solutionId, stage)),
        directory: useLoaded('dir', owner, () => api.getDirectory()),
        connections: useLoaded('conn', owner, () => api.getConnections()),
    };
}

export default function StageSettingsTab({ solutionId, solutionName, stage, stageRow, currentUserId = null, onChanged }: StageSettingsTabProps) {
    const { t } = useTranslation();
    const label = useStageLabel()(stage);
    const noticeText = useNoticeText();
    // The context is a .jsx module whose default value types only what it declares; this is the shape it provides.
    const lic = useLicenseContext() as unknown as { hasFeature: (name: string) => boolean; entDegraded?: boolean; entError?: unknown };
    const licensed = !!(lic.entDegraded || lic.entError || lic.hasFeature('approvals'));
    const { settings, role, owner, operate, reqs, vars, directory, connections } = useReads(solutionId, stage, stageRow?.role);

    const [notice, setNotice] = useState<SettingsError | null>(null);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [applyOpen, setApplyOpen] = useState(false);
    /** Every failed write ends here: a lost race reloads the page's data and keeps the edits. */
    const fail = (res: Fail): SettingsError => {
        const err = settingsError(res);
        setNotice(err);
        if (err.kind === 'stale') { settings.reload(); reqs.reload(); vars.reload(); }
        return err;
    };
    const ctx: Ctx = {
        solutionId, stage, settings, reqs, vars, onChanged, fail, setNotice, t,
        flag: (key, on) => setBusy(b => ({ ...b, [key]: on })),
    };
    const bindings = useBindingWrites(ctx);
    const values = useValueWrites(ctx);
    const parts = usePartWrites(ctx);
    const gateWrites = useGateWrites(ctx);
    const removal = useRemoval(ctx);

    const s = settings.data;
    if (!s) {
        if (settings.load === 'loading') {
            return <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]" data-testid="stage-settings-loading"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('stage_settings.loading', 'Loading...')}</div>;
        }
        return <Unreadable code={settings.load === 'no_access' ? 'no_access' : settings.code} onRetry={settings.reload} />;
    }

    const gateOn = applyNeedsApproval(stage, s);
    const reqRead = reqs.data as { requirements: Requirement[]; release: { seq: number | null } | null } | null;
    const navItems: SettingsNavItem[] = [
        { id: 'bindings', label: t('stage_settings.nav_bindings', 'Bindings') },
        { id: 'variables', label: t('stage_settings.nav_variables', 'Values') },
        { id: 'addresses', label: t('stage_settings.nav_addresses', 'Reach') },
        { id: 'access', label: t('stage_settings.nav_access', 'Access') },
        { id: 'parts', label: t('stage_settings.nav_parts', 'Parts') },
        ...(stage === 'prd' ? [{ id: 'gate', label: t('stage_settings.nav_gate', 'Gate') }] : []),
        { id: 'danger', label: t('stage_settings.nav_danger', 'Danger') },
    ];
    const request = s.currentRelease ? { stage, kind: 'redeploy' as const, releaseId: s.currentRelease.id, releaseSeq: s.currentRelease.seq } : null;

    return (
        <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-6 space-y-4 lg:space-y-0" data-testid="stage-settings" data-stage={stage}>
            <SettingsNav items={navItems} label={t('stage_settings.nav_label', 'Settings sections')} />
            <div className="space-y-4 min-w-0">
            {!owner && (
                <p className="flex items-start gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs border-l-2 border-[var(--text-tertiary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]" data-testid="settings-readonly">
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    {t('stage_settings.readonly_notice', 'You can look at these settings, but only an owner of this stage can change them.')}
                </p>
            )}
            {notice && notice.kind !== 'binding_invalid' && notice.kind !== 'policy_needs_approver' && (
                <p className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]" role="alert" data-testid={notice.kind === 'stale' ? 'settings-stale' : 'settings-notice'}>
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />{noticeText(notice)}
                </p>
            )}
            {s.bindingsPending && <PendingBanner canApply={owner} hasRelease={!!request} gateOn={gateOn} onApply={() => setApplyOpen(true)} />}

            <SettingsBlock id="bindings" title={t('stage_settings.bindings_title', 'What this stage needs')} description={t('stage_settings.bindings_intro', 'Connections, approvers and recipients are answered per stage, never copied silently from Dev.')}>
                <BindingsSection
                    stage={stage} load={operate ? reqs.load : 'no_access'} requirements={reqRead?.requirements || []} releaseSeq={reqRead?.release?.seq ?? null}
                    parts={s.parts} isOwner={owner} draft={bindings.draft} slotErrors={bindings.slotErrors} saving={!!busy.bindings}
                    onDraft={bindings.onDraft} directory={directory.data} connections={connections.data}
                    directoryLoad={directory.load} onRetryDirectory={directory.reload} onRetryConnections={connections.reload}
                    onSave={bindings.save} onDiscard={bindings.discard} onRetry={reqs.reload}
                />
            </SettingsBlock>
            <SettingsBlock id="variables" title={t('stage_settings.vars_title', 'Variables')} description={t('stage_settings.vars_intro', 'Values for this stage. Steering values apply with the next redeploy.')}>
                <VariablesSection
                    load={vars.load === 'no_access' ? 'error' : vars.load} decls={vars.data?.decls || []} values={vars.data?.values || []} role={role}
                    draft={values.draft} errors={values.errors} saving={!!busy.values} onSave={values.save} onRetry={vars.reload} onDraft={values.onDraft}
                />
            </SettingsBlock>
            <SettingsBlock id="addresses" title={t('stage_settings.addresses_title', 'Addresses')} description={t('stage_settings.addresses_intro', 'Where this stage can be reached from outside.')}>
                <AddressesSection inbound={s.inbound} isOwner={owner} />
            </SettingsBlock>
            <SettingsBlock id="access" title={t('stage_settings.access_title', 'Access and run-as')} description={t('stage_settings.access_intro', 'Access to a stage is its own; a role in Dev grants nothing here.')}>
                <AccessSection stageProjectId={s.projectId || stageRow?.projectId || ''} stageName={`${solutionName} · ${label}`} role={role} runAs={s.runAs} currentUserId={currentUserId} onLeft={onChanged} />
            </SettingsBlock>
            <SettingsBlock id="parts" title={t('stage_settings.parts_title', 'Parts')} description={t('stage_settings.parts_intro', 'Switch what runs in this stage on or off. What they contain is changed in Dev and deployed.')}>
                <PartsSection
                    parts={s.parts} canOperate={operate} canPause={operate || role === 'org_admin'} isOwner={owner} paused={s.paused} newPartsActive={s.newPartsActive}
                    busy={busy} errors={parts.errors} stageBusy={!!busy.pause} pauseNotice={parts.pauseNotice}
                    onSwitch={parts.switchPart} onPause={parts.pause} onNewPartsActive={(v) => gateWrites.patch({ newPartsActive: v })}
                />
            </SettingsBlock>
            {stage === 'prd' && (
                <SettingsBlock id="gate" title={t('stage_settings.gate_title', 'Approval gate')} description={t('stage_settings.gate_intro', 'Who must agree before Production changes.')}>
                    {owner && directory.load !== 'ok' && (
                        <LoadWarning
                            text={directory.load === 'loading' ? t('stage_settings.loading', 'Loading...') : t('stage_settings.people_unreadable', 'The people and groups of your organisation could not be loaded, so the current choice cannot be shown or changed here.')}
                            onRetry={directory.load === 'loading' ? undefined : directory.reload} testId="gate-directory-unreadable"
                        />
                    )}
                    {/* Keyed on the write epoch only: a reload (stale, bindings save, pause) must keep an unsaved gate edit. */}
                    <GateSection
                        key={gateWrites.gate.epoch} settings={s} isOwner={owner} licensed={licensed} directory={directory.data} busy={!!busy.stage}
                        outcome={gateWrites.gate.outcome} error={gateWrites.gate.error} onSave={gateWrites.patch}
                    />
                </SettingsBlock>
            )}
            <SettingsBlock id="danger" title={t('stage_settings.danger_title', 'Danger zone')} description={t('stage_settings.danger_intro', 'Detach this stage from the Solution, or take it down.')}>
                <DangerZone solutionName={solutionName} stageLabel={label} canAct={owner || role === 'org_admin'} gateOn={gateOn} busy={!!busy.danger} error={removal.danger.error} result={removal.danger.result} onSubmit={removal.remove} />
                {removal.danger.result === 'detached' && <Button size="sm" variant="secondary" onClick={onChanged} data-testid="danger-done">{t('stage_settings.danger_done', 'Back to the Solution')}</Button>}
            </SettingsBlock>

            {applyOpen && request && (
                <DeployDialog open solutionId={solutionId} solutionName={solutionName} request={request} onClose={() => { setApplyOpen(false); settings.reload(); reqs.reload(); vars.reload(); onChanged(); }} />
            )}
            </div>
        </div>
    );
}
