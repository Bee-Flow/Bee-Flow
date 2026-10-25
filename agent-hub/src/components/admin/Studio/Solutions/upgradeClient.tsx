import { ArrowUpCircle, HelpCircle } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { Strip } from './solutionNotices';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import type { IsNewerArgs, UpdateAvailabilityArgs, PlanItem, PlanManifest, PlanRow, PlanRows, UpgradeBody, UpgradeReport, ReadReport, PlanOutcome, UpgradeOutcome, FetchUpgradePlanArgs, RunUpgradeArgs, UpdateBannerProps, PlanState, DialogFooterProps, UpgradeDialogProps } from './upgradeClient.types';
import { DialogBody } from './DialogBody';
export { PlanBody } from './DialogBody';
export type { PlanRows, ReadReport } from './upgradeClient.types';

/**
 * Updating to a newer Blueprint: the banner, the plan, and the confirmation.
 *
 * There is nothing new on the server side — this runs on the EXISTING routes
 * `POST /:id/package/upgrade/plan` and `POST /:id/package/upgrade`. What is added
 * here is the one thing a user of an upgrade used to get: nothing.
 *
 * ── An upgrade is far-reaching, so the plan comes before the button ───────
 *
 * `planUpgrade` answers exactly the question someone has before confirming: what
 * happens to MY changes. The server returns four lists; this screen converts them
 * into named rows, and that translation is the whole content of this file:
 *
 *   ADDED        `plan.add`      — the update brings this in.
 *   CHANGED      `plan.replace`  — untouched since the installation, so the new
 *                                  version writes over it.
 *   STAYS        `plan.skip`     — and here it splits, see below.
 *   GONE         `plan.missing`  — once installed, now deleted. An update does
 *                                  not resurrect it.
 *
 * ── The split in “stays” is the point ─────────────────────────────────────
 *
 * `plan.skip` has two completely different meanings, and the server puts them in
 * the same list:
 *
 *   1. WE COMPARED IT AND YOU CHANGED IT. Only possible for the four kinds that the
 *      upgrade can replace (COMPARED_KINDS): for those, an `installHash` and a live
 *      payload exist to check against.
 *   2. WE NEVER COMPARED IT. A table and a knowledge base have no payload that the
 *      upgrade can hash (`currentPayload` gives `null` for them), so whether the
 *      installer changed something there is NOT DETERMINABLE HERE. Showing such a row
 *      as “stays” without more would claim that we had looked.
 *
 * This screen claims case 1 only if BOTH signals say so: the kind is one that can be
 * compared, AND the server's `why` mentions the edit. If either is missing or
 * changes, the row falls back to “not determinable” — the side that promises too
 * little rather than too much.
 *
 * ── Why the client does NOT send the manifest ─────────────────────────────
 *
 * Both routes accept either a `blueprintId` or an entire `manifest`. This screen
 * sends only the id. Then `resolveManifest` runs `canRead` over it, and the SERVER
 * decides whether this reader may have that Blueprint; a sent manifest would bypass
 * that check and make the client's bytes the truth. The banner also checks the scope
 * (see `updateAvailability`), but that is the second lock, not the first.
 */

/**
 * The kinds for which the upgrade can answer “did you change this?”.
 * Mirror of REPLACEABLE_KINDS in server/projects/packaging/upgrade.js. A kind that
 * is NOT in here — also one that is added next year — reads as “not determinable”,
 * never as “untouched”.
 */
const COMPARED_KINDS = new Set(['automation', 'app', 'webpage', 'agent']);

/** De entiteitenlijsten van een manifest, met de enkelvoudige soortnaam erbij. */
const ENTITY_LISTS = [
    ['automations', 'automation'], ['apps', 'app'], ['webpages', 'webpage'],
    ['datatables', 'datatable'], ['agents', 'agent'], ['knowledgeBases', 'knowledge_base'],
];

export function isNewer({ installedVersion, blueprintVersion }: IsNewerArgs) {
    return Number.isInteger(blueprintVersion) && blueprintVersion > (installedVersion || 0);
}

export function updateAvailability({ installedFromBlueprintId, installedVersion, blueprints }: UpdateAvailabilityArgs = {}) {
    const id = typeof installedFromBlueprintId === 'string' && installedFromBlueprintId ? installedFromBlueprintId : null;
    if (!id) return { state: 'none', blueprintId: null, installedVersion: null, latestVersion: null };

    const unknown = { state: 'unknown', blueprintId: null, installedVersion: null, latestVersion: null };
    // `null` is “the gallery could not be read” and is therefore not the same as an
    // empty list — but for this question the answer in both cases is: we do not know.
    if (!Array.isArray(blueprints)) return unknown;
    const found = blueprints.find(b => b && b.id === id);
    if (!found) return unknown;

    const latestVersion = Number.isInteger(found.version) && found.version > 0 ? found.version : null;
    // Without a read installed version there is nothing to compare against. This is
    // the guard that the server function lacks.
    const installed = Number.isFinite(installedVersion) ? Math.trunc(Number(installedVersion)) : null;
    if (latestVersion === null || installed === null) return unknown;

    return {
        state: isNewer({ installedVersion: installed, blueprintVersion: latestVersion }) ? 'available' : 'current',
        blueprintId: id,
        installedVersion: installed,
        latestVersion,
    };
}

// ── Het plan, in benoemde rijen ────────────────────────────────────────────

export function nameIndex(manifest: PlanManifest | null | undefined) {
    const index = new Map<string, string>();
    const entities = manifest?.solution?.entities;
    if (!entities || typeof entities !== 'object') return index;
    for (const [plural] of ENTITY_LISTS) {
        for (const entity of Array.isArray(entities[plural]) ? entities[plural] : []) {
            if (!entity || typeof entity.ref !== 'string' || !entity.ref) continue;
            const name = [entity.name, entity.title, entity.key]
                .find(v => typeof v === 'string' && v.trim());
            index.set(entity.ref, (name || entity.ref).trim());
        }
    }
    return index;
}

/** One plan row, with the name added and nothing else taken from the row. */
function rowOf(item: PlanItem, index: Map<string, string>): PlanRow {
    const ref = typeof item?.ref === 'string' ? item.ref : '';
    return { ref, kind: typeof item?.kind === 'string' ? item.kind : '', name: index.get(ref) || ref };
}

/**
 * The four server lists as five named groups.
 *
 * `undetermined` is the group that gives this function its reason to exist: it does
 * not exist on the server, but it does in reality — see the header.
 */
export function planRows(body: UpgradeBody | null | undefined): PlanRows {
    const plan: NonNullable<UpgradeBody['plan']> = body?.plan || {};
    const index = nameIndex(body?.manifest);
    const list = (v: PlanItem[] | undefined) => (Array.isArray(v) ? v : []);
    const kept: PlanRow[] = [];
    const undetermined: PlanRow[] = [];
    for (const item of list(plan.skip)) {
        const row = rowOf(item, index);
        // Two signals must agree before this screen claims that it WAS compared. If one
        // is missing, the answer is “not determined”.
        const comparable = COMPARED_KINDS.has(row.kind);
        const saysEdited = typeof item?.why === 'string' && /\bedited\b/i.test(item.why);
        (comparable && saysEdited ? kept : undetermined).push(row);
    }
    return {
        added: list(plan.add).map(i => rowOf(i, index)),
        changed: list(plan.replace).map(i => rowOf(i, index)),
        kept,
        undetermined,
        gone: list(plan.missing).map(i => rowOf(i, index)),
    };
}

/** Does this plan change anything? Otherwise the confirmation is an empty act. */
export function planTouchesNothing(rows: PlanRows | undefined) {
    return (rows?.added?.length || 0) === 0 && (rows?.changed?.length || 0) === 0;
}

// ── De twee requests ───────────────────────────────────────────────────────

async function post(url: string, body: { blueprintId: string | null | undefined }) {
    const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, body: parsed };
}

export async function fetchUpgradePlan({ projectId, blueprintId }: FetchUpgradePlanArgs): Promise<PlanOutcome> {
    try {
        const { ok, body } = await post(`${API_BASE}/api/projects/${projectId}/package/upgrade/plan`, { blueprintId });
        if (!ok || !body || body.ok !== true) return { status: 'error', error: body?.error || null };
        return { status: 'ok', rows: planRows(body), toVersion: body.toVersion ?? null };
    } catch {
        return { status: 'error', error: null };
    }
}

export async function runUpgrade({ projectId, blueprintId }: RunUpgradeArgs): Promise<UpgradeOutcome> {
    try {
        const { ok, body } = await post(`${API_BASE}/api/projects/${projectId}/package/upgrade`, { blueprintId });
        if (!ok || !body || body.ok !== true) return { status: 'error', error: body?.error || null };
        return { status: 'ok', report: readReport(body.report), toVersion: body.toVersion ?? null };
    } catch {
        return { status: 'error', error: null };
    }
}

/** The report, from an allow-list. Only counts and the sentences of the server. */
export function readReport(report: UpgradeReport | null | undefined): ReadReport {
    const added: Record<string, unknown> = report?.added && typeof report.added === 'object' ? report.added : {};
    const total = Object.values(added).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    const strings = (v: string[] | undefined) => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s) : []);
    return {
        replaced: Array.isArray(report?.replaced) ? report.replaced.length : 0,
        added: total,
        failed: (Array.isArray(report?.failed) ? report.failed : [])
            .filter(f => f && typeof f === 'object')
            .map(f => ({ ref: typeof f.ref === 'string' ? f.ref : '', why: typeof f.why === 'string' ? f.why : '' })),
        warnings: strings(report?.warnings),
    };
}

// ── De banner ──────────────────────────────────────────────────────────────

export function UpdateBanner({ availability, onOpen }: UpdateBannerProps) {
    const { t } = useTranslation();
    const state = availability?.state;
    if (state !== 'available' && state !== 'unknown') return null;

    if (state === 'unknown') {
        return (
            <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="solution-update-unknown">
                {t('solutions.update_unknown',
                    'Whether there is a newer version of this Solution could not be checked, so this is not "up to date".')}
            </Strip>
        );
    }

    return (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--warning)] bg-[var(--bg-secondary)] text-sm text-[var(--text-primary)]"
             data-testid="solution-update-available">
            <ArrowUpCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="flex-1 min-w-[12rem]">
                {t('solutions.update_available', 'Version {version} of the Blueprint this Solution came from is available. You have version {installed}.',
                    { version: availability.latestVersion, installed: availability.installedVersion })}
            </span>
            {/* No button without a handler: only the owner may update, and a button that does
                nothing is worse than no button. The line itself does remain — that there
                is a newer version is also news for someone who cannot apply it himself. */}
            {onOpen && (
                <button
                    onClick={onOpen}
                    data-testid="solution-update-open"
                    className="flex-shrink-0 px-3 min-h-[44px] sm:min-h-8 rounded-[var(--radius-sm)] text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {t('solutions.update_see_plan', 'See what would change')}
                </button>
            )}
        </div>
    );
}

// ── De bevestiging ─────────────────────────────────────────────────────────

function DialogFooter({ done, canConfirm, applying, onClose, onConfirm }: DialogFooterProps) {
    const { t } = useTranslation();
    return (
        <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 min-h-[44px] sm:min-h-8 rounded-[var(--radius-sm)] text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                {done ? t('solutions.upgrade_close', 'Close') : t('solutions.upgrade_cancel', 'Cancel')}
            </button>
            {canConfirm && (
                <button onClick={onConfirm} disabled={applying} data-testid="upgrade-confirm"
                        className="px-3 h-8 rounded-lg text-[13px] font-medium disabled:opacity-50"
                        style={PRIMARY_ACTION_STYLE}>
                    {t('solutions.upgrade_confirm', 'Update it')}
                </button>
            )}
        </div>
    );
}

export default function UpgradeDialog({ open, onClose, projectId, blueprintId, latestVersion = null, onDone }: UpgradeDialogProps) {
    const { t } = useTranslation();
    const [plan, setPlan] = useState<PlanState>({ status: 'loading' });
    const [applying, setApplying] = useState(false);
    const [result, setResult] = useState<UpgradeOutcome | null>(null);

    const load = useCallback(async () => {
        setPlan({ status: 'loading' });
        setResult(null);
        setPlan(await fetchUpgradePlan({ projectId, blueprintId }));
    }, [projectId, blueprintId]);

    // The dialog stays mounted while closed, so the plan from the previous time is
    // still there. Opening MUST clear that — an old plan next to a new button is
    // precisely the mistake this screen must prevent. Same exception, and for the same
    // reason, as the name draft in SolutionDetail.
    useEffect(() => {
        if (!open || !projectId || !blueprintId) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [open, projectId, blueprintId, load]);

    const confirm = async () => {
        setApplying(true);
        const outcome = await runUpgrade({ projectId, blueprintId });
        setApplying(false);
        setResult(outcome);
        if (outcome.status === 'ok') onDone?.();
    };

    const ready = plan.status === 'ok' && !result;
    const empty = ready && planTouchesNothing(plan.rows);

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            disableBackdropClose
            title={t('solutions.upgrade_title', 'Update this Solution')}
            description={latestVersion === null ? undefined
                : t('solutions.upgrade_intro', 'To version {version} of the Blueprint it came from.', { version: latestVersion })}
            footer={<DialogFooter done={result?.status === 'ok'} canConfirm={ready && !empty}
                                   applying={applying} onClose={onClose} onConfirm={confirm} />}
        >
            <DialogBody plan={plan} ready={ready} empty={empty} result={result} />
        </Modal>
    );
}
