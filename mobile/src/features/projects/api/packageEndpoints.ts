/**
 * Blueprint packaging (routes/projects/packaging.js), behind the
 * `blueprint_packaging` licence feature on every route — a 403 here is a plan
 * answer. Owner-only on everything under `/:id/package`.
 *
 * Upgrades send the Blueprint's ID, never a manifest: the server then runs
 * its own `canRead` over it and decides whether this reader may use that
 * Blueprint. A manifest sent by the client would bypass that check and make
 * the client's bytes the truth.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';

import { projectPath } from './endpoints';
import {
    readBlueprints,
    readInstallCounts,
    readInstallReport,
    readPublishResult,
    readReleases,
    readUpgradePlan,
} from './packageReaders';
import type {
    BlueprintMeta,
    InstallCounts,
    InstallReport,
    PublishResult,
    Release,
    UpgradePlan,
    UpgradeReport,
} from '../model/package';
import { readReport } from '../model/upgrade';

const BLUEPRINTS = '/api/projects/package/blueprints';

/** The Blueprints this caller could install — org-scoped, meta only. */
export async function listBlueprints(signal?: AbortSignal): Promise<BlueprintMeta[]> {
    return readBlueprints(await api.get<unknown>(BLUEPRINTS, { signal }));
}

export async function listReleases(id: string, signal?: AbortSignal): Promise<Release[]> {
    return readReleases(await api.get<unknown>(`${projectPath(id)}/package/releases`, { signal }));
}

export async function getInstallCounts(id: string, signal?: AbortSignal): Promise<InstallCounts> {
    return readInstallCounts(await api.get<unknown>(`${projectPath(id)}/package/installs`, { signal }));
}

export async function planUpgrade(id: string, blueprintId: string): Promise<UpgradePlan> {
    return readUpgradePlan(await api.post<unknown>(`${projectPath(id)}/package/upgrade/plan`, { blueprintId }));
}

/** Apply it. The server plans again itself; the report is counts plus its own sentences. */
export async function applyUpgrade(id: string, blueprintId: string): Promise<UpgradeReport> {
    const res = await api.post<unknown>(`${projectPath(id)}/package/upgrade`, { blueprintId }, { timeoutMs: 120_000 });
    if (pick(res, 'ok') !== true) throw new Error('The update did not go through.');
    return readReport(pick(res, 'report'));
}

/** Where a Blueprint to install comes from: the gallery, or a file's manifest. */
export type InstallSource = { blueprintId: string } | { manifest: Record<string, unknown> };

/**
 * Install as a NEW Solution. No `resolutions`: the phone has no connect step,
 * and everything left unanswered can be set in the Solution afterwards (the
 * wizard's own words). Everything arrives as a draft.
 */
export async function installBlueprint(source: InstallSource, name: string): Promise<InstallReport> {
    const body = { ...source, ...(name.trim() ? { name: name.trim() } : {}) };
    return readInstallReport(await api.post<unknown>('/api/projects/package/install', body, { timeoutMs: 120_000 }));
}

/**
 * Publish: capture the Solution and keep it on this instance as the next
 * version. The answer carries the whole manifest; only the three stamps
 * are read.
 */
export async function publishSolution(id: string): Promise<PublishResult> {
    return readPublishResult(
        await api.post<unknown>(`${projectPath(id)}/package/export`, { save: true }, { timeoutMs: 120_000 }),
    );
}

/**
 * Export: the Blueprint file itself, to hand to the share sheet. It is a
 * payload the app carries and never reads, so it is passed through as text.
 */
export async function exportSolution(id: string): Promise<string> {
    const manifest = await api.post<unknown>(`${projectPath(id)}/package/export`, { save: false }, { timeoutMs: 120_000 });
    if (manifest === null || typeof manifest !== 'object') throw new Error('The Blueprint could not be exported.');
    return JSON.stringify(manifest, null, 2);
}
