// The projects a finding is about, in the check's expansion: their CURRENT
// names (resolved by the server at read time from the ids in the evidence —
// the evidence itself never holds a name) and a link into each project.

import { ArrowUpRight } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { complianceActionPath } from '../../data/actions';

interface Offender { project_id?: string; link?: string | null }

export interface ProjectFindingCheck {
    scope_id?: string | null;
    evidence?: { offenders?: Offender[]; project_id?: string; link?: string | null } | null;
    project_names?: Record<string, string>;
}

const MAX_LISTED = 10;

/** `[{id, name, path}]` for the projects a result row refers to. */
export function affectedProjects(check: ProjectFindingCheck): Array<{ id: string; name: string; path: string | null }> {
    const ev = check.evidence || {};
    const names = check.project_names || {};
    const nameOf = (id: string) => names[id] || `project:${id.slice(0, 8)}`;
    const pathOf = (link: string | null | undefined) => (link ? complianceActionPath({ type: 'navigate', target: link }) : null);
    const offenders = Array.isArray(ev.offenders) ? ev.offenders.filter((o) => o && o.project_id) : [];
    if (offenders.length) {
        return offenders.map((o) => ({ id: String(o.project_id), name: nameOf(String(o.project_id)), path: pathOf(o.link) }));
    }
    const scope = check.scope_id && check.scope_id.startsWith('project:') ? check.scope_id.slice('project:'.length) : null;
    const id = ev.project_id || scope;
    return id ? [{ id, name: nameOf(id), path: pathOf(ev.link) }] : [];
}

export default function AffectedProjects({ check, onOpen, testId = 'affected-projects' }: {
    check: ProjectFindingCheck;
    onOpen?: (path: string) => void;
    testId?: string;
}) {
    const { t } = useTranslation();
    const list = affectedProjects(check);
    if (!list.length) return null;
    const shown = list.slice(0, MAX_LISTED);
    return (
        <ul className="m-0 p-0 list-none flex flex-col gap-0.5 text-[11px]" data-testid={testId}>
            {shown.map((p) => (
                <li key={p.id} className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate text-[var(--text-primary)]">{p.name}</span>
                    {p.path && onOpen ? (
                        <button
                            type="button"
                            onClick={() => onOpen(p.path as string)}
                            className="inline-flex items-center gap-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                            aria-label={`${t('compliance.tbl_open_subject', 'Open the affected item')}: ${p.name}`}
                            data-testid={`${testId}-open-${p.id}`}
                        >
                            <ArrowUpRight size={11} aria-hidden="true" />
                        </button>
                    ) : null}
                </li>
            ))}
            {list.length > shown.length ? (
                <li className="text-[var(--text-tertiary)]">+{list.length - shown.length}</li>
            ) : null}
        </ul>
    );
}
