import {
    AlertTriangle, CheckCircle2, HelpCircle, Info, Plus, Trash2,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { addressOf, CREATE_EMPTY } from './installRequirements';
import { COUNTED_SECTIONS, countPhrase } from './solutionCounts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * The four screens of the install wizard, and the pieces they share.
 *
 * Split out of InstallBlueprintModal so that file is the wizard's SHELL — which
 * step is showing, what the buttons do, what happens after the install — and
 * this one is what each step looks like. The decisions all live next door, in
 * that file's header; nothing here does more than render what it is handed.
 *
 * Two rules run through every screen below, and both have a test:
 *
 *   - A LIST THAT COULD NOT BE READ NEVER RENDERS AS AN EMPTY ONE. Every picker
 *     here can genuinely be empty, so each carries its own status and says
 *     which of the two it is. A silent empty picker teaches somebody their
 *     organisation has no tables.
 *   - WHAT THE FILE ASKED FOR ARRIVES UNTICKED. A page's tools run as whoever
 *     installed it, so a checkbox that came pre-ticked would hand over
 *     authority the file asked for — one screen above the code that was
 *     hardened to refuse exactly that.
 */

/** A list that could not be read must never render as an empty one. */
export function ListStatus({ status, testId }) {
    const { t } = useTranslation();
    if (status !== 'error') return null;
    return (
        <p className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--warning)' }} data-testid={testId}>
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            {t('solutions.install_list_failed', 'That list could not be loaded, so what you can choose from here is not the whole picture.')}
        </p>
    );
}

export function Row({ children, testId }) {
    return (
        <div className="px-3 py-2.5 rounded-lg space-y-1.5" style={{ background: 'var(--bg-secondary)' }} data-testid={testId}>
            {children}
        </div>
    );
}

const selectCls = 'w-full px-2 py-1.5 rounded-lg text-xs border outline-none';
const selectStyle = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)',
};

/** Where a step lives, said the way somebody could go and find it. */
function stepWhere(row, t) {
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

/**
 * Wat het bestand over zijn eigen herkomst zegt — als BEWERING.
 *
 * Een Blueprint komt van de schijf van de installateur, en `source.orgName` is
 * niets anders dan tekst die in dat bestand staat. Hij mag hier staan, want de
 * ontvanger wil weten wie beweert dit gestuurd te hebben; maar hij staat er
 * mét de zin eromheen die zegt wat hij is. Een kale afzenderregel zou van een
 * bewering een vastgesteld feit maken, en dat is precies het misverstand waar
 * iemand een gerust gevoel aan ontleent dat hij niet heeft.
 *
 * Niets hier beslist iets: de server bepaalt met `canRead` over de echte
 * galerijrij wat deze installateur mag, en die vraag raakt dit blok niet aan.
 * Zonder naam staat er niets — een lege regel "afkomstig van —" voegt niets toe.
 */
function SourceClaim({ source }) {
    const { t } = useTranslation();
    const name = source?.orgName;
    if (!name) return null;
    return (
        <p className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
            data-testid="install-source-claim">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>
                {source.version
                    ? t('solutions.install_source_claim_version',
                        'This file says it was published by "{name}", version {version}.',
                        { name, version: source.version })
                    : t('solutions.install_source_claim',
                        'This file says it was published by "{name}".', { name })}
                {' '}
                {t('solutions.install_source_unverified',
                    'That is what the file says about itself — anyone who can edit the file can change it. Check with whoever sent it.')}
            </span>
        </p>
    );
}

export function ContentsStep({ read, name, onName }) {
    const { t } = useTranslation();
    const kinds = COUNTED_SECTIONS.map(entry => entry.section).filter(section => read.counts[section] > 0);

    return (
        <div className="space-y-4">
            <SourceClaim source={read.source} />
            <label className="block">
                <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('solutions.install_name', 'Name for this Solution')}
                </span>
                <input
                    value={name}
                    onChange={(e) => onName(e.target.value)}
                    aria-label={t('solutions.install_name', 'Name for this Solution')}
                    className={selectCls}
                    style={selectStyle}
                />
            </label>

            <div>
                <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    {t('solutions.install_contains', 'What it brings')}
                </h3>
                {kinds.length === 0 ? (
                    <p className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                        {t('solutions.install_nothing_in_it', 'This Blueprint carries nothing at all.')}
                    </p>
                ) : (
                    <ul className="flex flex-wrap gap-1.5" data-testid="install-contents">
                        {kinds.map(kind => (
                            <li key={kind} className="px-2.5 py-1 rounded-lg text-xs"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                                {countPhrase(t, kind, read.counts[kind])}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* The exporter's own honesty, forwarded. It is the most valuable
                thing on the export screen and worth exactly as much here. */}
            {read.notCarried.length > 0 && (
                <div>
                    <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                        {t('projects.blueprint_left_behind', 'What this Blueprint does not carry')}
                    </h3>
                    <ul className="space-y-1" data-testid="install-not-carried">
                        {read.notCarried.map((w, i) => (
                            <li key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                                {w}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

// ── Step 2: the holes, and the requests ────────────────────────────

export function TableRows({ rows, catalog, choice, onChoice }) {
    const { t } = useTranslation();
    const tables = catalog.status === 'ok' ? (catalog.data?.datatables || []) : [];
    return rows.map(row => (
        <Row key={`tbl-${row.key}`} testId="install-require-table">
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {t('solutions.install_table_for', 'A table for "{key}"', { key: row.key })}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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

export function ConnectionRows({ rows, connections, choice, onChoice }) {
    const { t } = useTranslation();
    const items = connections.status === 'ok' ? (connections.data?.connections || []) : [];
    return rows.map(row => {
        const address = addressOf(row.ref, row.stepId, row.layerKey);
        return (
            <Row key={`conn-${address}`} testId="install-require-connection">
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {t('solutions.install_connection_for', 'A credential for this request')}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{stepWhere(row, t)}</p>
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

export function ApproverRows({ rows, people, groups, choice, onChoice }) {
    const { t } = useTranslation();
    const users = people.status === 'ok' && Array.isArray(people.data) ? people.data : [];
    const groupList = groups.status === 'ok' && Array.isArray(groups.data) ? groups.data : [];
    return rows.map(row => {
        const address = addressOf(row.ref, row.stepId, row.layerKey);
        return (
            <Row key={`appr-${address}`} testId="install-require-approver">
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {t('solutions.install_approver_for', 'Who approves here')}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{stepWhere(row, t)}</p>
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

/**
 * What the file asked each page to be allowed to do.
 *
 * Unticked, always. The whole point of the row is that the FILE cannot grant
 * it — a checkbox that arrived ticked would restore exactly the behaviour
 * install.js was hardened to remove, one screen higher up.
 */
export function GrantRows({ rows, catalog, ticked, onTick }) {
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
                    <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
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
                        {connected === false && t('solutions.install_grant_not_connected', 'Not connected to your account — connect it in Settings → Integrations, then grant it on the page.')}
                        {connected === 'unknown' && t('solutions.install_grant_status_unknown', 'Whether this app is connected could not be checked, so it cannot be handed over here — grant it on the page afterwards.')}
                    </p>
                </Row>
            );
        }
        if (row.kind === 'public_ai') {
            const cap = row.flags?.publicSpendCapUsd;
            return (
                <Row key={`grant-${i}`} testId="install-grant-public-ai">
                    <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                        {t('solutions.install_grant_public_ai',
                            '"{page}" asks to let anonymous visitors spend your AI budget.', { page: row.name })}
                    </p>
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {t('solutions.install_grant_foreign_automation',
                        '"{page}" wants to run an automation that is not in this file.', { page: row.name })}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('solutions.install_grant_foreign_automation_hint',
                        'It named one on the instance the file came from, so there is nothing here to point it at. Open the page and grant one of yours.')}
                </p>
            </Row>
        );
    });
}

export function ConnectStep({ read, catalog, connections, people, groups, choices, setChoices }) {
    const { t } = useTranslation();
    const { tables, connections: connRows, approvers } = read.requires;
    const nothing = tables.length === 0 && connRows.length === 0
        && approvers.length === 0 && read.grants.length === 0;

    const set = (bucket) => (key, value) => setChoices(prev => ({
        ...prev, [bucket]: { ...prev[bucket], [key]: value },
    }));

    return (
        <div className="space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('solutions.install_connect_intro',
                    'None of this travelled with the file. Answer what you can here; anything you leave can be set in the Solution afterwards.')}
            </p>
            {nothing && (
                <p className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                    {t('solutions.install_connect_none', 'Nothing here needs connecting.')}
                </p>
            )}

            <TableRows rows={tables} catalog={catalog} choice={choices.tables} onChoice={set('tables')} />
            <ConnectionRows rows={connRows} connections={connections} choice={choices.connections} onChoice={set('connections')} />
            <ApproverRows rows={approvers} people={people} groups={groups} choice={choices.approvers} onChoice={set('approvers')} />

            {read.grants.length > 0 && (
                <div className="space-y-2 pt-2">
                    <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('solutions.install_grants_title', 'What the file asks its pages to be allowed to do')}
                    </h3>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
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

/** The row that names somebody and says what they may do. */
function AccessAdder({ users, groups, onAdd }) {
    const { t } = useTranslation();
    const [type, setType] = useState('user');
    const [id, setId] = useState('');
    const [permission, setPermission] = useState('viewer');
    const options = type === 'user' ? users : groups;

    return (
        <div className="flex flex-wrap items-end gap-2">
                <select
                    className={`${selectCls} w-auto`} style={selectStyle} value={type}
                    aria-label={t('solutions.install_access_kind', 'People or groups')}
                    onChange={(e) => { setType(e.target.value); setId(''); }}
                >
                    <option value="user">{t('solutions.install_access_person', 'Person')}</option>
                    <option value="group">{t('solutions.install_access_group', 'Group')}</option>
                </select>
                <select
                    className={`${selectCls} flex-1 min-w-[160px]`} style={selectStyle} value={id}
                    aria-label={t('solutions.install_access_who', 'Who to add')}
                    onChange={(e) => setId(e.target.value)}
                >
                    <option value="">{t('solutions.install_access_pick', 'Choose…')}</option>
                    {options.map(o => (
                        <option key={o.id} value={o.id}>{o.username || o.email || o.name || o.id}</option>
                    ))}
                </select>
                <select
                    className={`${selectCls} w-auto`} style={selectStyle} value={permission}
                    aria-label={t('solutions.install_access_role', 'What they may do')}
                    onChange={(e) => setPermission(e.target.value)}
                >
                    <option value="viewer">{t('solutions.install_role_viewer', 'Can view')}</option>
                    <option value="editor">{t('solutions.install_role_editor', 'Can edit')}</option>
                </select>
                <button
                    type="button"
                    onClick={() => { if (id) { onAdd({ type, id, permission }); setId(''); } }}
                    disabled={!id}
                    className="px-2.5 py-1.5 rounded-lg text-xs border flex items-center gap-1 disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    data-testid="install-access-add"
                >
                    <Plus className="w-3 h-3" />
                    {t('solutions.install_access_add', 'Add')}
                </button>
        </div>
    );
}

export function AccessStep({ people, groups, access, setAccess }) {
    const { t } = useTranslation();
    const users = people.status === 'ok' && Array.isArray(people.data) ? people.data : [];
    const groupList = groups.status === 'ok' && Array.isArray(groups.data) ? groups.data : [];

    const labelFor = (entry) => {
        const found = (entry.type === 'user' ? users : groupList).find(x => x.id === entry.id);
        return found ? (found.username || found.email || found.name || entry.id) : entry.id;
    };

    return (
        <div className="space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('solutions.install_access_intro',
                    'Who else can reach this Solution. You install as its owner either way, and you can change this later on the project page.')}
            </p>

            <AccessAdder
                users={users}
                groups={groupList}
                onAdd={(entry) => {
                    // Adding the same person twice is not a second decision.
                    if (access.some(a => a.type === entry.type && a.id === entry.id)) return;
                    setAccess([...access, entry]);
                }}
            />
            <ListStatus status={people.status === 'error' ? 'error' : groups.status} testId="install-access-unavailable" />

            {access.length === 0 ? (
                <p className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                    {t('solutions.install_access_none', 'Nobody else, for now.')}
                </p>
            ) : (
                <ul className="space-y-1" data-testid="install-access-list">
                    {access.map(entry => (
                        <li key={`${entry.type}:${entry.id}`}
                            className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                            <span className="truncate">{labelFor(entry)}</span>
                            <span className="flex items-center gap-2 flex-shrink-0">
                                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                    {entry.permission === 'editor'
                                        ? t('solutions.install_role_editor', 'Can edit')
                                        : t('solutions.install_role_viewer', 'Can view')}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setAccess(access.filter(a => !(a.type === entry.type && a.id === entry.id)))}
                                    aria-label={t('solutions.install_access_remove', 'Remove')}
                                >
                                    <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ── After the install ──────────────────────────────────────────────

/**
 * What happened, including the parts that did not.
 *
 * `report.grantRequires` is the SERVER's list of what it refused to grant, and
 * it is rendered whether or not the Connect step spotted the same rows — the
 * client reads the file with its own eyes, and this is the answer from the side
 * that actually decides.
 */
export function ResultStep({ result, failures }) {
    const { t } = useTranslation();
    const report = result?.report || {};
    return (
        <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--success, #10b981)' }} />
                {t('solutions.install_installed', 'Installed.')}
            </p>

            {(report.skipped || []).length > 0 && (
                <ul className="space-y-1" data-testid="install-result-skipped">
                    {report.skipped.map((s, i) => (
                        <li key={i} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('projects.blueprint_skipped', 'Not installed')}: {s.kind} — {s.why}
                        </li>
                    ))}
                </ul>
            )}

            {(report.warnings || []).length > 0 && (
                <ul className="space-y-1" data-testid="install-result-warnings">
                    {report.warnings.map((w, i) => (
                        <li key={i} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{w}</li>
                    ))}
                </ul>
            )}

            {(report.grantRequires || []).length > 0 && (
                <div data-testid="install-result-grants">
                    <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                        {t('solutions.install_result_grants', 'Still to grant, on the pages themselves')}
                    </h3>
                    <ul className="space-y-1">
                        {report.grantRequires.map((row, i) => (
                            <li key={i} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {row.name || row.ref} — {row.tool || row.kind}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {failures.length > 0 && (
                <ul className="space-y-1" data-testid="install-result-failures">
                    {failures.map((f, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-primary)' }}>
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                            {f}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
