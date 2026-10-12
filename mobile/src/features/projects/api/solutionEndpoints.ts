/**
 * The builder's reads on a project (routes/projects.js): the Solutions
 * overview, the wiring graph, the checks — and the caller's own lists a
 * resource picker offers, one per movable kind.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';

import { projectPath } from './endpoints';
import { readCandidates } from './readers';
import { readCompleteness, readGraph, readSummary } from './solutionReaders';
import type { Completeness, SolutionGraph, SolutionSummary } from '../model/solution';

/** One card per Solution, every tally possibly `null` — see projects/summary.js. */
export async function getSolutionSummary(signal?: AbortSignal): Promise<SolutionSummary> {
    return readSummary(await api.get<unknown>('/api/projects/summary', { signal }));
}

export async function getProjectGraph(id: string, signal?: AbortSignal): Promise<SolutionGraph> {
    return readGraph(await api.get<unknown>(`${projectPath(id)}/graph`, { signal }));
}

/**
 * The checks, and the verdict publishing reads. An answer without a boolean
 * `blocked` is refused here rather than read with a default: an empty list is
 * what both a clean Solution and a broken response look like, and only one of
 * them may publish.
 */
export async function getCompleteness(id: string, signal?: AbortSignal): Promise<Completeness> {
    const res = await api.get<unknown>(`${projectPath(id)}/completeness`, { signal });
    if (typeof pick(res, 'blocked') !== 'boolean') throw new Error('The checks could not be run just now.');
    return readCompleteness(res);
}

/**
 * Where each movable kind's own listing lives, and the property its rows come
 * in (null = a bare array). Each was read off its route:
 * notebooks.js, studioApps.js, automation/crud.js, webpages/crud.js,
 * datatables/tables.js, agents/crud.js, skills.js, studioDocuments.js (templates)
 * and knowledgeBases/list.js.
 *
 * The web reads routines from /api/ai-tasks, which lists scheduled AI tasks —
 * a different store whose ids PUT /:id/resources cannot file. The phone reads
 * the automations list, which is what `kind: 'automation'` moves.
 */
const SOURCES: Readonly<Record<string, { path: string; key: string | null }>> = {
    notebook: { path: '/api/notebooks', key: 'notebooks' },
    app: { path: '/api/studio-apps', key: 'apps' },
    automation: { path: '/api/automation', key: 'automations' },
    webpage: { path: '/api/webpages', key: 'webpages' },
    datatable: { path: '/api/datatables', key: 'datatables' },
    agent: { path: '/agents', key: null },
    skill: { path: '/api/skills', key: null },
    document_template: { path: '/api/studio-documents?kind=template&limit=200', key: 'documents' },
    knowledge_base: { path: '/api/kb', key: null },
};

export interface Candidate {
    id: string;
    label: string | null;
}

/**
 * What the caller could file in, for one kind. A response without its list
 * throws: "you have none" and "the list did not load" send someone to
 * different places, so the two are never the same answer.
 */
export async function listCandidates(kind: string, signal?: AbortSignal): Promise<Candidate[]> {
    const source = SOURCES[kind];
    if (!source) return [];
    const res = await api.get<unknown>(source.path, { signal });
    const rows = source.key ? pick(res, source.key) : res;
    if (!Array.isArray(rows)) throw new Error('That list could not be loaded. Try again shortly.');
    return readCandidates(rows).filter((c) => c.id !== '');
}
