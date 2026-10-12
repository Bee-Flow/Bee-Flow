import { AlertTriangle, Check, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { DirectoryOptions } from '../../../../../automation/Builder/flow/settings/approvalStages';
import { newStageKey } from '../../../../../automation/Builder/flow/settings/formState';
import Button from '../../../../../shared/Button';
import type { StageKey } from '../stagesApi';
import { ChainEditor } from './GateSection';
import type { ConnectionOption, Directory } from './stageSettingsApi';
import {
    bindingProblem, bindingStatus, effectiveValue, groupRequirements, neededByNames,
    type BindingProblem, type Draft, type Requirement, type SettingsPart,
} from './stageSettingsModel';
import LoadWarning from './LoadWarning';
import { fromSeatEdit, slotSeatFlavour, toSeatEdit, type SeatEdit } from './seatShapes';

/**
 * The stage's bindings (design 4.1): everything the release needs that a stage
 * must answer for itself. Grouped by kind, each slot says which parts need it and
 * offers "Use the same as Dev", which is one deliberate click and never implicit.
 * Only the Solution owner reads or writes the values (they name connections,
 * tables and mail recipients); everyone else sees whether a slot is set.
 */

const INPUT = 'w-full px-2 py-1.5 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]';
const LINK = 'text-xs underline underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const seatCode = (s: unknown): string => { const o = asObj(s); return o.userId ? `u:${o.userId}` : o.groupId ? `g:${o.groupId}` : ''; };
const seatDecode = (code: string): Obj | null => (!code ? null : code[0] === 'u' ? { userId: code.slice(2) } : { groupId: code.slice(2) });
type DirProps = { directory: Directory | null };
const Directory_ = DirectoryOptions as unknown as React.ComponentType<DirProps>;

function SeatSelect({ value, onChange, directory, label, empty }: { value: unknown; onChange: (s: Obj | null) => void; directory: Directory | null; label: string; empty: string }) {
    const { t } = useTranslation();
    const code = seatCode(value);
    // A stored seat that is not in the list (the person left) stays visible instead of reading as "nobody".
    const known = !code || [...(directory?.members || []).map(m => `u:${m.id}`), ...(directory?.groups || []).map(g => `g:${g.id}`)].includes(code);
    return (
        <select value={code} aria-label={label} onChange={(e) => onChange(seatDecode(e.target.value))} className={INPUT}>
            <option value="">{empty}</option>
            {!known && <option value={code}>{t('stage_settings.seat_unknown', 'Not in the list ({id})', { id: code.slice(2) })}</option>}
            <Directory_ directory={directory} />
        </select>
    );
}

function ConnectionEditor({ value, stage, connections, onRetry, onChange }: { value: unknown; stage: StageKey; connections: ConnectionOption[] | null; onRetry: () => void; onChange: (v: unknown) => void }) {
    const { t } = useTranslation();
    const v = asObj(value);
    const hosts = Array.isArray(v.allowedHosts) ? v.allowedHosts.map(String) : [];
    const [text, setText] = useState(hosts.join(', '));
    // Typing keeps its own text (a trailing comma must survive); a value set from outside (Dev's, Undo) wins.
    const shown = text.split(/[\s,;]+/).filter(Boolean).join(',') === hosts.join(',') ? text : hosts.join(', ');
    const set = (patch: Obj) => onChange({ connectionId: v.connectionId ?? '', allowedHosts: hosts, ...patch });
    return (
        <div className="space-y-2">
            {connections === null ? (
                <>
                <LoadWarning text={t('stage_settings.connections_unreadable', 'Your connections could not be loaded, so the current choice cannot be shown here.')} onRetry={onRetry} testId="connections-unreadable" />
                <input className={INPUT} value={String(v.connectionId ?? '')} onChange={(e) => set({ connectionId: e.target.value })}
                    aria-label={t('stage_settings.conn_id', 'Connection id')} placeholder="conn_…" />
                </>
            ) : (
                <select className={INPUT} value={String(v.connectionId ?? '')} aria-label={t('stage_settings.conn_pick', 'Connection')} onChange={(e) => set({ connectionId: e.target.value })}>
                    <option value="">{t('stage_settings.conn_none', '- pick a connection -')}</option>
                    {!!v.connectionId && !connections.some(c => c.id === v.connectionId) && <option value={String(v.connectionId)}>{String(v.connectionId)}</option>}
                    {connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
            )}
            <label className="block text-xs text-[var(--text-tertiary)]">
                {stage === 'prd'
                    ? t('stage_settings.hosts_label_required', 'Allowed hosts (required in Production)')
                    : t('stage_settings.hosts_label', 'Allowed hosts')}
                <textarea
                    className={`${INPUT} mt-1`} rows={2} value={shown} placeholder="api.example.com"
                    onChange={(e) => { setText(e.target.value); set({ allowedHosts: e.target.value.split(/[\s,;]+/).filter(Boolean) }); }}
                />
            </label>
        </div>
    );
}

function SeatsEditor({ value, suggested, neededBy, parts, directory, onChange }: { value: unknown; suggested: unknown; neededBy: string[]; parts: SettingsPart[]; directory: Directory | null; onChange: (v: unknown) => void }) {
    const { t } = useTranslation();
    const flavour = slotSeatFlavour(neededBy, parts, value ?? suggested);
    const edit = toSeatEdit(value);
    const set = (patch: Partial<SeatEdit>) => onChange(fromSeatEdit({ ...edit, ...patch }, flavour));
    const panel = edit.approvers || [];
    // A seat row nobody was picked in yet cannot live in the stored shape (it is dropped), so it is counted here.
    const [empty, setEmpty] = useState(0);
    const rows: Array<Obj | null> = [...panel, ...Array(empty).fill(null)];
    const setRow = (i: number, seat: Obj | null) => {
        if (i < panel.length) { set({ approvers: panel.map((x, j) => (j === i ? seat : x)).filter(Boolean) }); return; }
        if (seat) { set({ approvers: [...panel, seat] }); setEmpty(empty - 1); }
    };
    const dropRow = (i: number) => (i < panel.length ? set({ approvers: panel.filter((_, j) => j !== i) }) : setEmpty(empty - 1));
    const chain = edit.stages || [];
    const pick = (field: 'assignee' | 'escalateTo' | 'finalApprover', label: string, none: string) => (
        <SeatSelect value={edit[field]} onChange={(s) => set({ [field]: s })} directory={directory} label={label} empty={none} />
    );
    if (chain.length) {
        return (
            <ChainEditor stages={chain} directory={directory} onChange={(stages) => set({ stages })} onDrop={() => set({ stages: [] })} />
        );
    }
    return (
        <div className="space-y-2">
            {pick('assignee', t('stage_settings.seat_assignee', 'Who decides'), t('stage_settings.seat_pick', '- pick a person or group -'))}
            {rows.map((seat, i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <div className="flex-1 min-w-0">
                        <SeatSelect value={seat} directory={directory} label={t('stage_settings.seat_panel', 'Panel member {n}', { n: i + 1 })}
                            empty={t('stage_settings.seat_pick', '- pick a person or group -')}
                            onChange={(picked) => setRow(i, picked)} />
                    </div>
                    <button type="button" aria-label={t('stage_settings.seat_remove', 'Remove panel member {n}', { n: i + 1 })}
                        onClick={() => dropRow(i)} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]">
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            ))}
            <div className="flex items-center gap-3 flex-wrap">
                <button type="button" className={LINK} onClick={() => setEmpty(empty + 1)}>
                    <Plus className="w-3 h-3 inline" aria-hidden="true" /> {t('stage_settings.seat_add_panel', 'Add a panel member')}
                </button>
                <button type="button" className={LINK} onClick={() => set({ stages: [{ key: newStageKey([]), name: '', description: '', approvers: panel.length ? panel : (edit.assignee ? [edit.assignee] : [null]), rule: 'all' }] })}>
                    {t('stage_settings.seat_use_chain', 'Ask in several stages')}
                </button>
            </div>
            {panel.length >= 2 && (
                <select className={INPUT} aria-label={t('stage_settings.seat_rule', 'Decision rule')} value={edit.rule || 'all'} onChange={(e) => set({ rule: e.target.value })}>
                    <option value="all">{t('stage_settings.rule_all', 'Everyone must approve')}</option>
                    <option value="first">{t('stage_settings.rule_first', 'First to respond decides')}</option>
                    <option value="quorum">{t('stage_settings.rule_quorum', 'At least N approvals')}</option>
                </select>
            )}
            {edit.rule === 'quorum' && (
                <input type="number" min={1} className={INPUT} aria-label={t('stage_settings.seat_quorum', 'Approvals needed')} value={edit.quorumCount ?? 2}
                    onChange={(e) => set({ quorumCount: Number(e.target.value) || 1 })} />
            )}
            {pick('escalateTo', t('stage_settings.seat_escalate', 'Escalate to'), t('stage_settings.seat_no_escalation', 'No escalation'))}
            {pick('finalApprover', t('stage_settings.seat_final', 'Final approver'), t('stage_settings.seat_no_final', 'No final approver'))}
        </div>
    );
}

const EVENTS = ['onError', 'onApproval', 'onSuccess'] as const;

function NotifyEditor({ value, directory, onChange }: { value: unknown; directory: Directory | null; onChange: (v: unknown) => void }) {
    const { t } = useTranslation();
    const v = asObj(value);
    const names: Record<string, string> = {
        onError: t('stage_settings.notify_on_error', 'When a run fails'),
        onApproval: t('stage_settings.notify_on_approval', 'When approval is asked'),
        onSuccess: t('stage_settings.notify_on_success', 'When a run succeeds'),
    };
    const recipientsOf = (ev: string) => (Array.isArray(asObj(v[ev]).recipients) ? (asObj(v[ev]).recipients as Obj[]) : []);
    const setEvent = (ev: string, recipients: Obj[]) => {
        const next: Obj = { ...v, [ev]: { ...asObj(v[ev]), recipients } };
        onChange(next);
    };
    return (
        <div className="space-y-2">
            {EVENTS.map(ev => {
                const list = recipientsOf(ev);
                return (
                    <div key={ev} className="space-y-1">
                        <p className="text-xs text-[var(--text-tertiary)]">{names[ev]}</p>
                        {list.map((r, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                                <div className="flex-1 min-w-0">
                                    <SeatSelect
                                        value={r.type === 'group' ? { groupId: r.id } : { userId: r.id }} directory={directory}
                                        label={t('stage_settings.notify_recipient', '{event}, recipient {n}', { event: names[ev], n: i + 1 })}
                                        empty={t('stage_settings.seat_pick', '- pick a person or group -')}
                                        onChange={(s) => setEvent(ev, list.map((x, j) => (j === i ? (s ? { type: s.groupId ? 'group' : 'user', id: s.groupId ?? s.userId } : { type: 'user', id: '' }) : x)).filter(x => x.id))}
                                    />
                                </div>
                                <button type="button" aria-label={t('stage_settings.notify_remove', 'Remove recipient')} onClick={() => setEvent(ev, list.filter((_, j) => j !== i))}
                                    className="p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]"><X className="w-3.5 h-3.5" aria-hidden="true" /></button>
                            </div>
                        ))}
                        <select className={INPUT} value="" aria-label={t('stage_settings.notify_add', '{event}: add a recipient', { event: names[ev] })}
                            onChange={(e) => { const s = seatDecode(e.target.value); if (s) setEvent(ev, [...list, { type: s.groupId ? 'group' : 'user', id: s.groupId ?? s.userId }]); }}>
                            <option value="">{t('stage_settings.notify_add_ph', '+ add a person or group')}</option>
                            <Directory_ directory={directory} />
                        </select>
                    </div>
                );
            })}
        </div>
    );
}

/** The kinds that are one id or one word: tables, documents, knowledge bases, addresses. */
function SimpleEditor({ req, value, onChange }: { req: Requirement; value: unknown; onChange: (v: unknown) => void }) {
    const { t } = useTranslation();
    const v = asObj(value);
    const field = req.kind === 'table' ? 'datatableId' : req.kind === 'document' ? 'documentId' : req.kind === 'webpage_slug' ? 'slug' : req.kind === 'knowledge_base' ? 'kbIds' : null;
    const stored = field === 'kbIds' ? (Array.isArray(v.kbIds) ? v.kbIds.join(', ') : '') : String(field ? v[field] ?? '' : '');
    const [text, setText] = useState(stored);
    if (!field) {
        return <p className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.same_only', 'This setting can only be copied from Dev or cleared.')}</p>;
    }
    const ids = (s: string) => s.split(/[\s,;]+/).filter(Boolean);
    // Typing keeps its own text; a value set from outside (Dev's, Undo) wins.
    const same = field === 'kbIds' ? ids(text).join(',') === ids(stored).join(',') : text === stored;
    return (
        <input
            className={`${INPUT} font-mono`} value={same ? text : stored} aria-label={req.label}
            placeholder={req.kind === 'webpage_slug' ? 'my-page' : 'id'}
            onChange={(e) => { setText(e.target.value); onChange(field === 'kbIds' ? { kbIds: ids(e.target.value) } : { [field]: e.target.value }); }}
        />
    );
}

export interface BindingsSectionProps {
    stage: StageKey;
    load: 'loading' | 'ok' | 'error' | 'no_access';
    requirements: Requirement[];
    releaseSeq: number | null;
    parts: SettingsPart[];
    isOwner: boolean;
    draft: Draft;
    onDraft: (slot: string, value: unknown | undefined) => void;
    directory: Directory | null;
    connections: ConnectionOption[] | null;
    /** How the two pickers' reads went: a failed one is said, never shown as an empty list. */
    directoryLoad: 'loading' | 'ok' | 'error' | 'no_access';
    onRetryDirectory: () => void;
    onRetryConnections: () => void;
    slotErrors: Record<string, string>;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onRetry: () => void;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function BindingsSection(p: BindingsSectionProps) {
    const { t } = useTranslation();
    const groupNames: Record<string, string> = {
        connections: t('stage_settings.group_connections', 'Connections'),
        approvers: t('stage_settings.group_approvers', 'Approvers'),
        notify: t('stage_settings.group_notify', 'Who is notified'),
        data: t('stage_settings.group_data', 'Tables and knowledge'),
        exposure: t('stage_settings.group_exposure', 'Addresses and access grants'),
    };
    const problemText: Record<BindingProblem, string> = {
        connection_missing: t('stage_settings.problem_connection', 'Pick a connection.'),
        hosts_required: t('stage_settings.problem_hosts_required', 'Production needs at least one allowed host.'),
        hosts_invalid: t('stage_settings.problem_hosts_invalid', 'One of these hosts is not a hostname.'),
        no_seat: t('stage_settings.problem_no_seat', 'Pick at least one person or group.'),
        no_recipient: t('stage_settings.problem_no_recipient', 'Add at least one recipient.'),
        slug_invalid: t('stage_settings.problem_slug', 'Use lowercase letters, digits and dashes.'),
        id_missing: t('stage_settings.problem_id', 'Enter an id.'),
    };
    const whys: Record<string, string> = {
        other_stage: t('stage_settings.why_other_stage', 'This belongs to another stage or to Dev, so it cannot be used here.'),
        connection_unusable: t('stage_settings.why_connection_unusable', 'The person this stage runs as may not use this connection.'),
        hosts_required: t('stage_settings.problem_hosts_required', 'Production needs at least one allowed host.'),
        invalid_hosts: t('stage_settings.problem_hosts_invalid', 'One of these hosts is not a hostname.'),
        seat_invalid: t('stage_settings.why_seat_invalid', 'One of these people or groups is not in the organisation.'),
        no_seat: t('stage_settings.problem_no_seat', 'Pick at least one person or group.'),
        invalid_value: t('stage_settings.why_invalid_value', 'This value is not valid for this setting.'),
    };
    const whyText = (why: string) => whys[why] || t('stage_settings.why_other', 'The server refused this value ({why}).', { why: why.replace(/_/g, ' ') });
    const statusText = { missing: t('stage_settings.status_missing', 'Missing'), bound: t('stage_settings.status_bound', 'Set'), changed: t('stage_settings.status_changed', 'Edited'), cleared: t('stage_settings.status_cleared', 'Will be cleared') };

    if (p.load === 'loading') return <p className="text-sm text-[var(--text-tertiary)]">{t('stage_settings.loading', 'Loading...')}</p>;
    if (p.load === 'no_access') {
        return <p className="text-sm text-[var(--text-tertiary)]" data-testid="bindings-no-access">{t('stage_settings.bindings_no_access', 'Only the owner and editors of this stage can see how it is wired. That is not the same as nothing being wired.')}</p>;
    }
    if (p.load === 'error') {
        return (
            <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]" data-testid="bindings-unreadable">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
                {t('stage_settings.bindings_unreadable', 'The settings this release needs could not be read, so this is not "none needed".')}
                <button type="button" className={LINK} onClick={p.onRetry}>{t('stage_settings.retry', 'Try again')}</button>
            </p>
        );
    }
    if (p.requirements.length === 0) {
        return <p className="text-sm text-[var(--text-tertiary)]" data-testid="bindings-none">{p.releaseSeq === null ? t('stage_settings.bindings_no_release', 'No release has been cut yet, so nothing is asked of this stage.') : t('stage_settings.bindings_none', 'Release {seq} needs nothing to be set for this stage.', { seq: p.releaseSeq })}</p>;
    }
    const dirty = Object.keys(p.draft).length > 0;
    const blocked = p.requirements.some(r => r.slot in p.draft && bindingProblem(r, p.draft[r.slot], p.stage));

    return (
        <div className="space-y-4" data-testid="settings-bindings">
            {groupRequirements(p.requirements).map(({ group, items }) => (
                <div key={group} className="space-y-2" data-testid={`bindings-group-${group}`}>
                    <h4 className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{groupNames[group]}</h4>
                    {items.map(req => {
                        const status = bindingStatus(req, p.draft);
                        const value = effectiveValue(req, p.draft);
                        const problem = req.slot in p.draft ? bindingProblem(req, p.draft[req.slot], p.stage) : null;
                        const canCopy = p.isOwner && req.suggested !== undefined && req.suggested !== null && !sameJson(value, req.suggested);
                        const needed = neededByNames(req, p.parts);
                        return (
                            <div key={req.slot} className="rounded-lg p-3 space-y-2 bg-[var(--bg-secondary)]" data-testid={`binding-${req.slot}`} data-status={status}>
                                <div className="flex items-start justify-between gap-2 flex-wrap">
                                    <div>
                                        <p className="text-sm font-medium text-[var(--text-primary)]">{req.label}</p>
                                        {needed.length > 0 && (
                                            <p className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.needed_by', 'Needed by {names}', { names: needed.join(', ') })}</p>
                                        )}
                                    </div>
                                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${status === 'missing' ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'} bg-[var(--bg-tertiary)]`}>
                                        {status === 'bound' && <Check className="w-3 h-3 inline mr-1" aria-hidden="true" />}{statusText[status]}
                                    </span>
                                </div>
                                {p.isOwner && (
                                    <>
                                        {req.kind === 'connection' && <ConnectionEditor value={value} stage={p.stage} connections={p.connections} onRetry={p.onRetryConnections} onChange={(v) => p.onDraft(req.slot, v)} />}
                                        {req.kind === 'approver_seats' && p.directoryLoad !== 'ok' && (
                                            <LoadWarning
                                                text={p.directoryLoad === 'loading' ? t('stage_settings.loading', 'Loading...') : t('stage_settings.people_unreadable', 'The people and groups of your organisation could not be loaded, so the current choice cannot be shown or changed here.')}
                                                onRetry={p.directoryLoad === 'loading' ? undefined : p.onRetryDirectory} testId="directory-unreadable"
                                            />
                                        )}
                                        {req.kind === 'approver_seats' && p.directoryLoad === 'ok' && req.slot.startsWith('seats:') && <SeatsEditor value={value} suggested={req.suggested} neededBy={req.neededBy} parts={p.parts} directory={p.directory} onChange={(v) => p.onDraft(req.slot, v)} />}
                                        {req.kind === 'approver_seats' && p.directoryLoad === 'ok' && req.slot.startsWith('notify:') && <NotifyEditor value={value} directory={p.directory} onChange={(v) => p.onDraft(req.slot, v)} />}
                                        {!['connection', 'approver_seats'].includes(req.kind) && <SimpleEditor req={req} value={value} onChange={(v) => p.onDraft(req.slot, v)} />}
                                        <div className="flex items-center gap-3 flex-wrap">
                                            {canCopy && <button type="button" className={LINK} onClick={() => p.onDraft(req.slot, req.suggested)}>{t('stage_settings.use_dev', 'Use the same as Dev')}</button>}
                                            {(req.bound || req.slot in p.draft) && status !== 'cleared' && <button type="button" className={LINK} onClick={() => p.onDraft(req.slot, null)}>{t('stage_settings.clear', 'Clear')}</button>}
                                            {req.slot in p.draft && <button type="button" className={LINK} onClick={() => p.onDraft(req.slot, undefined)}>{t('stage_settings.undo', 'Undo')}</button>}
                                        </div>
                                    </>
                                )}
                                {problem && <p className="text-xs text-[var(--error)]" data-testid={`binding-problem-${req.slot}`}>{problemText[problem]}</p>}
                                {p.slotErrors[req.slot] && <p className="text-xs text-[var(--error)]" data-testid={`binding-refused-${req.slot}`}>{whyText(p.slotErrors[req.slot])}</p>}
                            </div>
                        );
                    })}
                </div>
            ))}
            {p.isOwner && (
                <div className="flex items-center gap-2">
                    <Button size="sm" disabled={!dirty || blocked || p.saving} busy={p.saving} onClick={p.onSave} data-testid="bindings-save">{t('stage_settings.save_bindings', 'Save settings')}</Button>
                    {dirty && <Button size="sm" variant="ghost" onClick={p.onDiscard}>{t('stage_settings.discard', 'Discard')}</Button>}
                </div>
            )}
        </div>
    );
}
