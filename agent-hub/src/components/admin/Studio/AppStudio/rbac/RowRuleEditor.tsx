import { Database, Loader2 } from 'lucide-react';
import { SetStateAction, Dispatch, useEffect, useMemo, useRef, useState } from 'react';
import { validateRowFilterExpr } from './rowFilterSubset';
import RowRuleScope, { ruleActionLabel } from './RowRuleScope';
import RowRuleOutcome from './RowRuleOutcome';
import RowRuleSection from './RowRuleSection';
import { conditionProblem, matchBaseScope, resolveAccessEntry, scopeToEntry } from './rowRuleModel';
import { BASE_SCOPES } from './rowRuleModel.constants';
import { activeSlots, draftToRule, seedRuleSet, storedRule, withPerAction } from './rowRuleSet';
import type { RuleAction, RuleSet, RuleSlot } from './rowRuleSet';
import useAppRoles from './useAppRoles';
import useTranslation, { TranslateParams } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/shared/EmptyState';
import SegmentedControl from '@/components/shared/SegmentedControl';
import toast from '@/components/shared/Toast';
import type { AppRole, DataModelTable } from './useAppRoles';
import type { AccessEntry, RuleTable } from './rowRuleModel.types';
import type { RuleDraft, RowRuleEditorProps } from './RowRuleEditor.types';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

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
 *                     base access, narrowing WHICH rows the role may touch, or
 *                     a rule per action (seeing / changing / deleting): see
 *                     rowRuleSet.ts for how the stored value maps to drafts.
 *
 * The rule is authored with pickers (RowRuleBuilder over rowRuleModel), which
 * generate the same bounded expression the gateway accepts. "Write it myself"
 * drops to the raw box, and a stored rule the pickers cannot show EXACTLY opens
 * there untouched — a rule this editor does not understand is never rewritten
 * from a partial reading. Both paths validate against the client mirror of the
 * server subset before the owner can save.
 */

function findTable(tables: DataModelTable[], id: string) {
    return (tables || []).find((t) => t && (t.id === id || t.key === id)) || null;
}

function sameAccess(a: AccessEntry, b: AccessEntry) {
    return !!a && !!b && a.read === b.read && a.create === b.create
        && a.update === b.update && a.delete === b.delete;
}

/** What is stored for this role: one rule (text), a rule per action (an object), or nothing. */
function currentRule(table: DataModelTable, role: string): unknown {
    const rf = table?.access?.rowFilters;
    return (rf && typeof rf === 'object') ? rf[role] : null;
}

/** What a rule set would store, as one comparable text (the unsaved-changes check). */
function ruleKey(set: RuleSet) {
    const stored = storedRule(set);
    return stored === undefined ? 'kept' : JSON.stringify(stored);
}

/** Why a rule cannot be saved, named by its action when there is a rule per action. */
function invalidRuleMessage(invalid: { slot: RuleSlot; validation: { error: string | null | undefined } }, t: TranslateFn) {
    const problem = invalid.validation.error || t('studio_apps_edit.rule_editor.fix_rule', 'Fix the rule first.');
    return invalid.slot === 'all'
        ? problem
        : t('studio_apps_rowrules.problem_in_action', '{action}: {problem}', { action: ruleActionLabel(invalid.slot, t), problem });
}

/** Every draft that will be saved, with what still stands in its way. */
function checkRuleSet(set: RuleSet, table: RuleTable | null, t: TranslateFn) {
    return activeSlots(set).map((slot) => {
        const draft = set[slot];
        const text = draftToRule(draft);
        return {
            slot,
            text,
            validation: validateRowFilterExpr(text, table, t),
            // A half-filled condition is dropped by buildRowRule, which would silently save a
            // WIDER rule than the screen shows — block instead.
            unfinished: draft.mode === 'build' && draft.conditions.some((c) => conditionProblem(c, table, t)),
        };
    });
}

export default function RowRuleEditor({ appId, onDirtyChange = null }: RowRuleEditorProps) {
    const { t } = useTranslation();
    const { roles, tables, saveTableAccess, savingAccess } = useAppRoles(appId);

    const [tableId, setTableId] = useState('');
    const [roleKey, setRoleKey] = useState('');
    const [access, setAccess] = useState(() => scopeToEntry('all'));
    const [ruleSet, setRuleSet] = useState<RuleSet>(() => seedRuleSet(null, null));
    // With a rule per action: the action whose rule is on screen.
    const [action, setAction] = useState<RuleAction>('read');
    const [saved, setSaved] = useState(() => ({ access: scopeToEntry('all'), rule: 'null' }));
    const [pendingSwitch, setPendingSwitch] = useState<{ tableId: string; } | { roleKey: string; } | null>(null);

    // Default the pickers once data is present (during render: no extra pass).
    if (!tableId && tables.length) setTableId(tables[0].id as string);
    if (!roleKey && roles.length) setRoleKey(roles[0].key);

    const table = useMemo(() => findTable(tables, tableId), [tables, tableId]);

    // Re-seed the editor whenever the (table, role) selection changes.
    useAdjustOnChange([table, roleKey], () => {
        if (!table || !roleKey) return;
        const nextAccess = resolveAccessEntry(table, roleKey);
        const next = seedRuleSet(currentRule(table, roleKey), table);
        setAccess(nextAccess);
        setRuleSet(next);
        setAction('read');
        // Reading a hand-typed rule back normalises it (=== → ==, column first),
        // so the baseline is what the pickers WOULD write — otherwise the editor
        // would claim unsaved changes the moment it opened.
        setSaved({ access: nextAccess, rule: ruleKey(next) });
    });

    // The draft on screen: the one rule, or the rule of the picked action.
    const slot: RuleSlot = ruleSet.perAction ? action : 'all';
    const draft = ruleSet[slot];
    const setDraft: Dispatch<SetStateAction<RuleDraft>> = (update) => setRuleSet((prev) => {
        const at: RuleSlot = prev.perAction ? action : 'all';
        return { ...prev, [at]: typeof update === 'function' ? update(prev[at]) : update };
    });
    const dirty = !sameAccess(access, saved.access) || ruleKey(ruleSet) !== saved.rule;

    // The host (the Roles & access tabs) blocks closing while there is unsaved work.
    const dirtyChangeRef = useRef(onDirtyChange);
    useEffect(() => { dirtyChangeRef.current = onDirtyChange; });
    useEffect(() => { dirtyChangeRef.current?.(dirty); }, [dirty]);
    useEffect(() => () => dirtyChangeRef.current?.(false), []);

    // Switching table or role re-seeds the editor, so an unsaved edit would be
    // thrown away without a trace — ask first.
    const applySwitch = (patch: { tableId: string; } | { roleKey: string; } | null) => {
        if (!patch) return;
        if ('tableId' in patch) setTableId(patch.tableId);
        if ('roleKey' in patch) setRoleKey(patch.roleKey);
    };
    const requestSwitch = (patch: { tableId: string; } | { roleKey: string; }) => {
        if (dirty) setPendingSwitch(patch);
        else applySwitch(patch);
    };

    const checks = useMemo(() => checkRuleSet(ruleSet, table, t), [ruleSet, table, t]);
    const validation = checks.find((c) => c.slot === slot)?.validation || { ok: true, error: null };
    const unfinished = checks.some((c) => c.unfinished);
    // The first rule that would not save, named by its action when there is a rule per action.
    const invalid = checks.find((c) => c.text.trim() && !c.validation.ok);

    // No preset match → the role was set up in more detail than these three
    // buttons; the entry is written back untouched.
    const preset = matchBaseScope(access);
    const noAccess = access.read === 'none';

    const roleLabel = roles.find((r) => r.key === roleKey)?.label || roleKey || t('studio_apps_edit.rule_editor.this_role', 'This role');
    const tableName = table?.name || table?.key || t('studio_apps_edit.rule_editor.this_table', 'this table');

    const doSave = async () => {
        if (!table || !roleKey) return;
        if (unfinished) { toast.error(t('studio_apps_edit.rule_editor.finish_conditions', 'Finish every condition of the rule first.')); return; }
        if (invalid) { toast.error(invalidRuleMessage(invalid, t)); return; }
        try {
            // undefined: a stored rule this screen cannot show stays exactly as it is.
            const stored = storedRule(ruleSet);
            await saveTableAccess(table.id as string, {
                roles: { [roleKey]: access },
                ...(stored === undefined ? {} : { rowFilters: { [roleKey]: stored } }),
            });
            setSaved({ access, rule: ruleKey(ruleSet) });
            toast.success(t('studio_apps_edit.rule_editor.saved', 'Row access saved.'));
        } catch (err) {
            const errBody = (err as { body?: { errors?: unknown } } | null)?.body;
            const first = Array.isArray(errBody?.errors) && errBody.errors.length ? errBody.errors[0] as string : null;
            toast.error(first || (err as Error)?.message || t('studio_apps_edit.rule_editor.save_failed', 'Could not save row access.'));
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
            <RowRuleEditorSection2 t={t} tableId={tableId} requestSwitch={requestSwitch} tables={tables} roleKey={roleKey} roles={roles} />

            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">
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
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {t('studio_apps_edit.rule_editor.mixed_access', 'This role was given a more detailed mix of what it may do than these three buttons cover. Leave them alone to keep it exactly as it is — picking one replaces it.')}
                    </span>
                )}
            </div>

            <RowRuleScope
                t={t}
                ruleSet={ruleSet}
                action={action}
                disabled={noAccess}
                onPerAction={(perAction) => setRuleSet((prev) => withPerAction(prev, perAction, table, action))}
                onAction={setAction}
            />

            {ruleSet.kept ? (
                <span data-testid="row-rule-kept" className="text-[11px] text-[var(--text-tertiary)]">
                    {t('studio_apps_rowrules.kept_as_is', 'The rule stored for this role is in a form this screen cannot show. It stays exactly as it is; saving here changes only the access above.')}
                </span>
            ) : (
                <RowRuleSection t={t} draft={draft} setDraft={setDraft} noAccess={noAccess} table={table} validation={validation} />
            )}

            <RowRuleOutcome t={t} ruleSet={ruleSet} access={access} table={table} roleLabel={roleLabel} tableName={tableName} />

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={doSave}
                    disabled={savingAccess || unfinished || !!invalid}
                    className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
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

function RowRuleEditorSection2({ t, tableId, requestSwitch, tables, roleKey, roles }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; tableId: string; requestSwitch: (patch: { tableId: string; } | { roleKey: string; }) => void; tables: DataModelTable[]; roleKey: string; roles: AppRole[]; }) {
    return <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-secondary)]">{t('studio_apps_edit.rule_editor.table', 'Table')}</span>
            <select
                value={tableId}
                onChange={(e) => requestSwitch({ tableId: e.target.value })}
                aria-label={t('studio_apps_edit.rule_editor.table', 'Table')}
                className="rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
            >
                {tables.map((t) => <option key={t.id} value={t.id}>{t.name || t.key}</option>)}
            </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--text-secondary)]">{t('studio_apps_edit.rule_editor.role', 'Role')}</span>
            <select
                value={roleKey}
                onChange={(e) => requestSwitch({ roleKey: e.target.value })}
                aria-label={t('studio_apps_edit.rule_editor.role', 'Role')}
                className="rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
            >
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
            </select>
        </label>
    </div>;
}
