import { AlertTriangle, Database, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { validateRowFilterExpr } from './rowFilterSubset';
import RowRuleBuilder from './RowRuleBuilder';
import {
    BASE_SCOPES,
    buildRowRule,
    compareSourceLabel,
    conditionProblem,
    describeAccessOutcome,
    describeRowRule,
    matchBaseScope,
    parseRowRule,
    resolveAccessEntry,
    ruleFields,
    scopeToEntry,
} from './rowRuleModel';
import useAppRoles from './useAppRoles';
import useTranslation from '../../../../../hooks/useTranslation';
import { insertAtCursor } from '../../../../../utils/bindingHelpers';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import EmptyState from '../../../../shared/EmptyState';
import SegmentedControl from '../../../../shared/SegmentedControl';
import toast from '../../../../shared/Toast';

/**
 * RowRuleEditor — per-table, per-role row-level access.
 *
 * Two levers, both written into the DATA MODEL (server-enforced by the RLS
 * gateway, not this component):
 *   • Base access   — access.roles[role]: every row / only the ones they added /
 *                     nothing. One click sets reading AND writing, so the labels
 *                     name both (BASE_SCOPES / describeAccessOutcome). An entry
 *                     that matches no preset (set up elsewhere, e.g. read every
 *                     row but change none) is kept EXACTLY as it stands unless
 *                     the owner picks a preset — saving a rule must never widen
 *                     what a role may do.
 *   • Row rule      — access.rowFilters[role]: one expression ANDed onto the
 *                     base access, narrowing WHICH rows the role may touch.
 *
 * The rule is authored with pickers (RowRuleBuilder over rowRuleModel), which
 * generate the same bounded expression the gateway accepts. "Write it myself"
 * drops to the raw box, and a stored rule the pickers cannot show EXACTLY opens
 * there untouched — a rule this editor does not understand is never rewritten
 * from a partial reading. Both paths validate against the client mirror of the
 * server subset before the owner can save.
 */

const VIEWER_CHIPS = ['viewer.id', 'viewer.organizationId', 'viewer.role'];

function findTable(tables, id) {
    return (tables || []).find((t) => t && (t.id === id || t.key === id)) || null;
}

function sameAccess(a, b) {
    return !!a && !!b && a.read === b.read && a.create === b.create
        && a.update === b.update && a.delete === b.delete;
}

function currentRule(table, role) {
    const rf = table?.access?.rowFilters;
    return (rf && typeof rf === 'object' && typeof rf[role] === 'string') ? rf[role] : '';
}

function seedDraft(rule, table) {
    const parsed = parseRowRule(rule, table);
    return parsed.ok
        ? { mode: 'build', join: parsed.join, conditions: parsed.conditions, raw: rule }
        : { mode: 'raw', join: 'and', conditions: [], raw: rule };
}

function draftToRule(draft) {
    return draft.mode === 'raw' ? draft.raw : buildRowRule(draft);
}

export default function RowRuleEditor({ appId, onDirtyChange = null }) {
    const { t } = useTranslation();
    const { roles, tables, saveTableAccess, savingAccess } = useAppRoles(appId);

    const [tableId, setTableId] = useState('');
    const [roleKey, setRoleKey] = useState('');
    const [access, setAccess] = useState(() => scopeToEntry('all'));
    const [draft, setDraft] = useState({ mode: 'build', join: 'and', conditions: [], raw: '' });
    const [saved, setSaved] = useState(() => ({ access: scopeToEntry('all'), rule: '' }));
    const [pendingSwitch, setPendingSwitch] = useState(null);

    // Default the pickers once data is present.
    useEffect(() => {
        if (!tableId && tables.length) setTableId(tables[0].id);
    }, [tables, tableId]);
    useEffect(() => {
        if (!roleKey && roles.length) setRoleKey(roles[0].key);
    }, [roles, roleKey]);

    const table = useMemo(() => findTable(tables, tableId), [tables, tableId]);

    // Re-seed the editor whenever the (table, role) selection changes.
    useEffect(() => {
        if (!table || !roleKey) return;
        const nextAccess = resolveAccessEntry(table, roleKey);
        const next = seedDraft(currentRule(table, roleKey), table);
        setAccess(nextAccess);
        setDraft(next);
        // Reading a hand-typed rule back normalises it (=== → ==, column first),
        // so the baseline is what the pickers WOULD write — otherwise the editor
        // would claim unsaved changes the moment it opened.
        setSaved({ access: nextAccess, rule: draftToRule(next) });
    }, [table, roleKey]);

    const rule = draftToRule(draft);
    const dirty = !sameAccess(access, saved.access) || rule.trim() !== saved.rule.trim();

    // The host (the Roles & access tabs) blocks closing while there is unsaved work.
    const dirtyChangeRef = useRef(onDirtyChange);
    useEffect(() => { dirtyChangeRef.current = onDirtyChange; });
    useEffect(() => { dirtyChangeRef.current?.(dirty); }, [dirty]);
    useEffect(() => () => dirtyChangeRef.current?.(false), []);

    // Switching table or role re-seeds the editor, so an unsaved edit would be
    // thrown away without a trace — ask first.
    const applySwitch = (patch) => {
        if (patch.tableId !== undefined) setTableId(patch.tableId);
        if (patch.roleKey !== undefined) setRoleKey(patch.roleKey);
    };
    const requestSwitch = (patch) => {
        if (dirty) setPendingSwitch(patch);
        else applySwitch(patch);
    };

    const validation = useMemo(() => validateRowFilterExpr(rule, table, t), [rule, table, t]);
    // A half-filled condition is dropped by buildRowRule, which would silently save a
    // WIDER rule than the screen shows — block instead.
    const unfinished = draft.mode === 'build'
        ? draft.conditions.some((c) => conditionProblem(c, table, t))
        : false;
    const canSwitchToBuilder = useMemo(
        () => draft.mode === 'raw' && parseRowRule(draft.raw, table).ok,
        [draft.mode, draft.raw, table],
    );

    // No preset match → the role was set up in more detail than these three
    // buttons; the entry is written back untouched.
    const preset = matchBaseScope(access);
    const noAccess = access.read === 'none';

    const roleLabel = roles.find((r) => r.key === roleKey)?.label || roleKey || t('studio_apps_edit.rule_editor.this_role', 'This role');
    const tableName = table?.name || table?.key || t('studio_apps_edit.rule_editor.this_table', 'this table');
    const outcome = describeAccessOutcome({
        entry: access,
        roleLabel,
        tableName,
        hasRule: !!rule.trim(),
        ruleSummary: draft.mode === 'build' ? describeRowRule(draft, table, t) : '',
        t,
    });

    const doSave = async () => {
        if (!table || !roleKey) return;
        if (unfinished) { toast.error(t('studio_apps_edit.rule_editor.finish_conditions', 'Finish every condition of the rule first.')); return; }
        if (!validation.ok) { toast.error(validation.error || t('studio_apps_edit.rule_editor.fix_rule', 'Fix the rule first.')); return; }
        try {
            await saveTableAccess(table.id, {
                roles: { [roleKey]: access },
                rowFilters: { [roleKey]: rule.trim() || null },
            });
            setSaved({ access, rule });
            toast.success(t('studio_apps_edit.rule_editor.saved', 'Row access saved.'));
        } catch (err) {
            const first = Array.isArray(err?.body?.errors) && err.body.errors.length ? err.body.errors[0] : null;
            toast.error(first || err?.message || t('studio_apps_edit.rule_editor.save_failed', 'Could not save row access.'));
        }
    };

    if (roles.length === 0) {
        return (
            <EmptyState
                icon={<Database className="h-8 w-8" aria-hidden="true" />}
                title={t('studio_apps_edit.rule_editor.no_roles', 'No roles yet')}
                description={t('studio_apps_edit.rule_editor.no_roles_desc', 'Create roles on the Roles tab first, then set what each role can see row-by-row here.')}
            />
        );
    }
    if (tables.length === 0) {
        return (
            <EmptyState
                icon={<Database className="h-8 w-8" aria-hidden="true" />}
                title={t('studio_apps_edit.rule_editor.no_tables', 'No tables yet')}
                description={t('studio_apps_edit.rule_editor.no_tables_desc', "Add tables to this app's data first — row rules decide which of a table's rows a role may access.")}
            />
        );
    }

    return (
        <div data-testid="row-rule-editor" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                    <span style={{ color: 'var(--text-secondary)' }}>{t('studio_apps_edit.rule_editor.table', 'Table')}</span>
                    <select
                        value={tableId}
                        onChange={(e) => requestSwitch({ tableId: e.target.value })}
                        aria-label={t('studio_apps_edit.rule_editor.table', 'Table')}
                        className="rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        {tables.map((t) => <option key={t.id} value={t.id}>{t.name || t.key}</option>)}
                    </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                    <span style={{ color: 'var(--text-secondary)' }}>{t('studio_apps_edit.rule_editor.role', 'Role')}</span>
                    <select
                        value={roleKey}
                        onChange={(e) => requestSwitch({ roleKey: e.target.value })}
                        aria-label={t('studio_apps_edit.rule_editor.role', 'Role')}
                        className="rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        {roles.map((r) => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
                    </select>
                </label>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('studio_apps_edit.rule_editor.start_with', 'Start with')}
                </span>
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('studio_apps_edit.rule_editor.start_with', 'Start with')}
                    value={preset || ''}
                    onChange={(value) => setAccess(scopeToEntry(value))}
                    options={BASE_SCOPES.map((s) => ({ value: s.value, label: t(s.labelKey, s.label) }))}
                />
                {preset ? null : (
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_edit.rule_editor.mixed_access', 'This role was given a more detailed mix of what it may do than these three buttons cover. Leave them alone to keep it exactly as it is — picking one replaces it.')}
                    </span>
                )}
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {t('studio_apps_edit.rule_editor.then_keep', 'Then keep only the rows where…')}{' '}
                        <span style={{ color: 'var(--text-tertiary)' }}>{t('studio_apps_edit.rule_editor.optional', '(optional)')}</span>
                    </span>
                    {draft.mode === 'build' ? (
                        <button
                            type="button"
                            onClick={() => setDraft((prev) => ({ ...prev, mode: 'raw', raw: draftToRule(prev) }))}
                            disabled={noAccess}
                            className="text-[11px] hover:underline disabled:opacity-50"
                            style={{ color: 'var(--accent-primary)' }}
                        >
                            {t('studio_apps_edit.rule_editor.write_myself', 'Write it myself')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setDraft(seedDraft(draft.raw, table))}
                            disabled={noAccess || !canSwitchToBuilder}
                            className="text-[11px] hover:underline disabled:opacity-50"
                            style={{ color: 'var(--accent-primary)' }}
                        >
                            {t('studio_apps_edit.rule_editor.back_to_picker', 'Back to the picker')}
                        </button>
                    )}
                </div>

                {draft.mode === 'build' ? (
                    <RowRuleBuilder
                        table={table}
                        join={draft.join}
                        conditions={draft.conditions}
                        disabled={noAccess}
                        onChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
                    />
                ) : (
                    <>
                        {draft.raw.trim() && !canSwitchToBuilder ? (
                            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                {t('studio_apps_edit.rule_editor.stays_text', 'This rule does more than the picker can show, so it stays as text — it is saved exactly as written.')}
                            </span>
                        ) : null}
                        <RawRuleBox
                            table={table}
                            value={draft.raw}
                            disabled={noAccess}
                            error={rule.trim() && !validation.ok ? validation.error : null}
                            onChange={(raw) => setDraft((prev) => ({ ...prev, raw }))}
                        />
                    </>
                )}
            </div>

            <div
                data-testid="row-rule-outcome"
                className="rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-tertiary)' }}
            >
                <p style={{ color: 'var(--text-primary)' }}>{outcome.sees}</p>
                {outcome.writes ? (
                    <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>{outcome.writes}</p>
                ) : null}
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{outcome.owner}</p>
            </div>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={doSave}
                    disabled={savingAccess || unfinished || (!!rule.trim() && !validation.ok)}
                    className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {savingAccess ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                    {t('studio_apps_edit.rule_editor.save', 'Save row access')}
                </button>
            </div>

            <ConfirmDialog
                open={!!pendingSwitch}
                title={t('studio_apps_edit.rule_editor.discard_title', 'Discard your unsaved changes?')}
                description={t('studio_apps_edit.rule_editor.discard_desc', 'You changed who can see which rows in {table} but have not saved it yet. Switching now throws that change away.', { table: tableName })}
                confirmLabel={t('studio_apps_edit.rule_editor.discard', 'Discard changes')}
                cancelLabel={t('studio_apps_edit.rule_editor.keep_editing', 'Keep editing')}
                destructive
                onConfirm={() => { applySwitch(pendingSwitch); setPendingSwitch(null); }}
                onCancel={() => setPendingSwitch(null)}
            />
        </div>
    );
}

/**
 * "Write it myself" — the expression itself. The chips insert a column or a
 * runtime value at the cursor so the exact spelling never has to be remembered.
 */
function RawRuleBox({ table, value, onChange, disabled, error }) {
    const { t } = useTranslation();
    const ref = useRef(null);
    const insert = (text) => {
        const result = insertAtCursor(ref.current, text);
        onChange(result != null ? result : (value ? `${value} ${text}` : text));
    };

    return (
        <div className="flex flex-col gap-1.5">
            <textarea
                ref={ref}
                rows={2}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                placeholder={t('studio_apps_edit.rule_editor.raw_example', 'e.g. record.owner_id == viewer.id')}
                spellCheck={false}
                aria-label={t('studio_apps_edit.rule_editor.raw_aria', 'Row rule expression')}
                className="w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 disabled:opacity-50"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            />
            <div className="flex flex-wrap items-center gap-1.5">
                {ruleFields(table, t).slice(0, 8).map((f) => (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => insert(`record.${f.key}`)}
                        disabled={disabled}
                        title={f.name}
                        className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        record.{f.key}
                    </button>
                ))}
                {VIEWER_CHIPS.map((path) => (
                    <button
                        key={path}
                        type="button"
                        onClick={() => insert(path)}
                        disabled={disabled}
                        title={compareSourceLabel(path, t)}
                        className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        {path}
                    </button>
                ))}
            </div>
            {error ? (
                <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-500 dark:text-rose-400" data-rule-error="true">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                </div>
            ) : null}
        </div>
    );
}
