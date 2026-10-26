import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import React, { useMemo } from 'react';
import { addressOf, CREATE_EMPTY, type BlueprintReadOk, type GrantRow, type SourceClaim as SourceClaimData, type StepAddress, type TableRequirement } from './installRequirements';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { nOf } from '../KnowledgeStudio/plural';
import type { Catalog, CatalogDatatable } from '@/components/automation/Builder/mapping/upstream/upstream.types';
import type { WaitlistUser } from '../../subscriptions/access/useSignupSettings';
import type { RowProps, TableRowsProps, ConnectionRowsProps, ApproverRowsProps, GrantRowsProps, InstallChoices, ConnectStepProps, InstallReport, InstallPayload, ResultStepProps } from './installWizardSteps.types';
import { ListStatus, selectCls, selectStyle } from './AccessStep';
;
;
export type { InstallChoices, InstallReport, InstallPayload } from './installWizardSteps.types';

function Row({ children, testId }: RowProps) {
    return (
        <div className="px-3 py-2.5 rounded-lg space-y-1.5 bg-[var(--bg-secondary)]" data-testid={testId}>
            {children}
        </div>
    );
}

/** Where a step lives, said the way somebody could go and find it. */
function stepWhere(row: StepAddress, t: TranslateFn) {
    const parts = [t('solutions.install_at_step', 'step {step}', { step: row.stepId })];
    if (row.title) parts.push(t('solutions.install_in_automation', 'in {name}', { name: row.title }));
    if (row.layerKey) parts.push(t('solutions.install_in_flowlet', 'flowlet {key}', { key: row.layerKey }));
    return parts.join(' · ');
}

// ── Step 1: what is in it ──────────────────────────────────────────

/*
 * "3 automations", and "1 automation" when there is one — from solutionCounts, which
 * the overview card's chip row reads too. The reasoning behind the key shape
 * lives there; the reason it is shared is that the two screens count the same
 * seven things and must not word them differently.
 */

// ── Step 2: the holes, and the requests ────────────────────────────

function TableRows({ rows, catalog, choice, onChoice }: TableRowsProps) {
    const { t } = useTranslation();
    const tables: Array<CatalogDatatable & { key?: string }> = catalog.status === 'ok' ? (catalog.data?.datatables || []) : [];
    return rows.map(row => (
        <Row key={`tbl-${row.key}`} testId="install-require-table">
            <p className="text-sm text-[var(--text-primary)]">
                {t('solutions.install_table_for', 'A table for "{key}"', { key: row.key })}
            </p>
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {nOf(t, 'solutions.install_used_by_steps', row.steps.length,
                    'Used by {count} step', 'Used by {count} steps')}
            </p>
            <select
                className={selectCls}
                style={selectStyle}
                aria-label={t('solutions.install_table_for', 'A table for "{key}"', { key: row.key })}
                value={choice[row.key] || ''}
                onChange={(e) => onChoice(row.key, e.target.value)}
            >
                <option value="">{t('solutions.install_table_pick', 'Choose a table…')}</option>
                <option value={CREATE_EMPTY}>{t('solutions.install_table_create', 'Create an empty table')}</option>
                {tables.map(tbl => (
                    <option key={tbl.id} value={tbl.id}>
                        {tbl.name}{tbl.key ? ` (${tbl.key})` : ''}
                    </option>
                ))}
            </select>
            <ListStatus status={catalog.status} testId="install-tables-unavailable" />
        </Row>
    ));
}

function ConnectionRows({ rows, connections, choice, onChoice }: ConnectionRowsProps) {
    const { t } = useTranslation();
    const items = connections.status === 'ok' ? (connections.data?.connections || []) : [];
    return rows.map(row => {
        const address = addressOf(row.ref, row.stepId, row.layerKey);
        return (
            <Row key={`conn-${address}`} testId="install-require-connection">
                <p className="text-sm text-[var(--text-primary)]">
                    {t('solutions.install_connection_for', 'A credential for this request')}
                </p>
                <p className="text-[11px] text-[var(--text-tertiary)]">{stepWhere(row, t)}</p>
                <select
                    className={selectCls}
                    style={selectStyle}
                    aria-label={`${t('solutions.install_connection_for', 'A credential for this request')} — ${stepWhere(row, t)}`}
                    value={choice[address] || ''}
                    onChange={(e) => onChoice(address, e.target.value)}
                >
                    <option value="">{t('solutions.install_connection_pick', 'Leave it unset')}</option>
                    {items.map(conn => (
                        <option key={conn.id} value={conn.id}>{conn.label || conn.name || conn.id}</option>
                    ))}
                </select>
                <ListStatus status={connections.status} testId="install-connections-unavailable" />
            </Row>
        );
    });
}

function ApproverRows({ rows, people, groups, choice, onChoice }: ApproverRowsProps) {
    const { t } = useTranslation();
    const users = people.status === 'ok' && Array.isArray(people.data) ? people.data : [];
    const groupList = groups.status === 'ok' && Array.isArray(groups.data) ? groups.data : [];
    return rows.map(row => {
        const address = addressOf(row.ref, row.stepId, row.layerKey);
        return (
            <Row key={`appr-${address}`} testId="install-require-approver">
                <p className="text-sm text-[var(--text-primary)]">
                    {t('solutions.install_approver_for', 'Who approves here')}
                </p>
                <p className="text-[11px] text-[var(--text-tertiary)]">{stepWhere(row, t)}</p>
                <select
                    className={selectCls}
                    style={selectStyle}
                    aria-label={`${t('solutions.install_approver_for', 'Who approves here')} — ${stepWhere(row, t)}`}
                    value={choice[address] || ''}
                    onChange={(e) => onChoice(address, e.target.value)}
                >
                    <option value="">{t('solutions.install_approver_owner', 'Leave it to the Solution’s owner')}</option>
                    {users.map(u => <option key={u.id} value={`user:${u.id}`}>{u.username || u.email || u.id}</option>)}
                    {groupList.map(g => <option key={g.id} value={`group:${g.id}`}>{g.name || g.id}</option>)}
                </select>
                <ListStatus status={people.status === 'error' ? 'error' : groups.status} testId="install-people-unavailable" />
            </Row>
        );
    });
}

function GrantRows({ rows, catalog, ticked, onTick }: GrantRowsProps) {
    const { t } = useTranslation();
    const byTool = useMemo(() => {
        const map = new Map();
        for (const app of (catalog.status === 'ok' ? (catalog.data?.apps || []) : [])) {
            for (const action of (app.actions || [])) {
                if (action?.name) map.set(action.name, app);
            }
        }
        return map;
    }, [catalog]);

    return rows.map((row, i) => {
        if (row.kind === 'integration') {
            const app = byTool.get(row.tool) || null;
            // Three answers, not two. A catalogue that could not be READ is not
            // "you have not connected this" — saying so would send somebody to
            // Settings for an app they already have. Both of the not-yes cases
            // refuse the tick, which is the narrow direction: a grant is only
            // offered where the connection is confirmed.
            const connected = catalog.status === 'error' ? 'unknown' : (app ? app.available === true : false);
            const key = `${row.ref}|${row.tool}`;
            return (
                <Row key={`grant-${i}`} testId="install-grant-integration">
                    <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={!!ticked[key]}
                            disabled={connected !== true}
                            onChange={(e) => onTick(key, e.target.checked, row)}
                            aria-label={t('solutions.install_grant_tool', 'Let "{page}" use {tool}', { page: row.name, tool: row.tool })}
                        />
                        <span>
                            {t('solutions.install_grant_tool', 'Let "{page}" use {tool}', { page: row.name, tool: row.tool })}
                        </span>
                    </label>
                    <p className="flex items-center gap-1 text-[11px]"
                       style={{ color: connected === true ? 'var(--success, #10b981)' : 'var(--text-tertiary)' }}>
                        {connected === true ? <CheckCircle2 className="w-3 h-3" /> : <HelpCircle className="w-3 h-3" />}
                        {connected === true && t('solutions.install_grant_connected', 'Connected to your account')}
                        {connected === false && t('solutions.install_grant_not_connected', 'Not connected to your account — connect it in Settings → Connections, then grant it on the page.')}
                        {connected === 'unknown' && t('solutions.install_grant_status_unknown', 'Whether this app is connected could not be checked, so it cannot be handed over here — grant it on the page afterwards.')}
                    </p>
                </Row>
            );
        }
        if (row.kind === 'public_ai') {
            const cap = row.flags?.publicSpendCapUsd;
            return (
                <Row key={`grant-${i}`} testId="install-grant-public-ai">
                    <p className="text-sm text-[var(--text-primary)]">
                        {t('solutions.install_grant_public_ai',
                            '"{page}" asks to let anonymous visitors spend your AI budget.', { page: row.name })}
                    </p>
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {typeof cap === 'number'
                            ? t('solutions.install_grant_public_ai_cap',
                                'It asks for up to ${cap} a day. Installing never switches this on — open the page and decide there.',
                                { cap })
                            : t('solutions.install_grant_public_ai_off',
                                'Installing never switches this on — open the page and decide there.')}
                    </p>
                </Row>
            );
        }
        return (
            <Row key={`grant-${i}`} testId="install-grant-automation">
                <p className="text-sm text-[var(--text-primary)]">
                    {t('solutions.install_grant_foreign_automation',
                        '"{page}" wants to run an automation that is not in this file.', { page: row.name })}
                </p>
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {t('solutions.install_grant_foreign_automation_hint',
                        'It named one on the instance the file came from, so there is nothing here to point it at. Open the page and grant one of yours.')}
                </p>
            </Row>
        );
    });
}

export function ConnectStep({ read, catalog, connections, people, groups, choices, setChoices }: ConnectStepProps) {
    const { t } = useTranslation();
    const { tables, connections: connRows, approvers } = read.requires;
    const nothing = tables.length === 0 && connRows.length === 0
        && approvers.length === 0 && read.grants.length === 0;

    const set = (bucket: 'tables' | 'connections' | 'approvers') => (key: string, value: string) => setChoices(prev => ({
        ...prev, [bucket]: { ...prev[bucket], [key]: value },
    }));

    return (
        <div className="space-y-3">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('solutions.install_connect_intro',
                    'None of this travelled with the file. Answer what you can here; anything you leave can be set in the Solution afterwards.')}
            </p>
            {nothing && (
                <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                    {t('solutions.install_connect_none', 'Nothing here needs connecting.')}
                </p>
            )}

            <TableRows rows={tables} catalog={catalog} choice={choices.tables} onChoice={set('tables')} />
            <ConnectionRows rows={connRows} connections={connections} choice={choices.connections} onChoice={set('connections')} />
            <ApproverRows rows={approvers} people={people} groups={groups} choice={choices.approvers} onChoice={set('approvers')} />

            {read.grants.length > 0 && (
                <div className="space-y-2 pt-2">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {t('solutions.install_grants_title', 'What the file asks its pages to be allowed to do')}
                    </h3>
                    <p className="text-xs text-[var(--text-secondary)]">
                        {t('solutions.install_grants_intro',
                            'A page’s tools run as whoever installed it, so installing grants none of these. Tick the ones you want to hand over yourself.')}
                    </p>
                    <GrantRows
                        rows={read.grants}
                        catalog={catalog}
                        ticked={choices.grants}
                        onTick={(key, on, row) => setChoices(prev => ({
                            ...prev,
                            grants: { ...prev.grants, [key]: on ? row : false },
                        }))}
                    />
                </div>
            )}
        </div>
    );
}

// ── Step 3: who else can reach it ──────────────────────────────────

// ── After the install ──────────────────────────────────────────────

export function ResultStep({ result, failures }: ResultStepProps) {
    const { t } = useTranslation();
    const report: InstallReport = result?.report || {};
    return (
        <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <CheckCircle2 className="w-4 h-4 [color:var(--success,#10b981)]" />
                {t('solutions.install_installed', 'Installed.')}
            </p>

            {(report.skipped || []).length > 0 && (
                <ul className="space-y-1" data-testid="install-result-skipped">
                    {report.skipped?.map((s, i) => (
                        <li key={i} className="text-xs text-[var(--text-tertiary)]">
                            {t('projects.blueprint_skipped', 'Not installed')}: {s.kind} — {s.why}
                        </li>
                    ))}
                </ul>
            )}

            {(report.warnings || []).length > 0 && (
                <ul className="space-y-1" data-testid="install-result-warnings">
                    {report.warnings?.map((w, i) => (
                        <li key={i} className="text-xs text-[var(--text-tertiary)]">{w}</li>
                    ))}
                </ul>
            )}

            {(report.grantRequires || []).length > 0 && (
                <div data-testid="install-result-grants">
                    <h3 className="text-sm font-medium mb-1 text-[var(--text-primary)]">
                        {t('solutions.install_result_grants', 'Still to grant, on the pages themselves')}
                    </h3>
                    <ul className="space-y-1">
                        {report.grantRequires?.map((row, i) => (
                            <li key={i} className="text-xs text-[var(--text-tertiary)]">
                                {row.name || row.ref} — {row.tool || row.kind}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {failures.length > 0 && (
                <ul className="space-y-1" data-testid="install-result-failures">
                    {failures.map((f, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 [color:var(--warning)]" />
                            {f}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
