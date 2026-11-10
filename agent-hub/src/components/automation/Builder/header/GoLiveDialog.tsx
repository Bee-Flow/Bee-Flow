import { useRef, useState } from 'react';
import Modal from '@/components/shared/Modal';
import useTranslation from '@/hooks/useTranslation';
import { readinessStamp, useReadiness, type Readiness } from '@/api/queries/automation/readiness';
import { useAiActCheck } from '@/api/queries/automation/aiActCheck';
import { useWorkingVsLiveDiffQuery } from '@/api/queries/automation/versions';
import FieldDiffTable from '../versions/FieldDiffTable';
import { aiActVisible } from '../settings/AiActSection';
import { ReadinessChecklist, readinessItems } from '../settings/ReadinessChecklist';
import { PRIMARY_BTN, SECONDARY_BTN } from '../settings/settingsUi';
import { liveStateOf, type LiveRow, type LiveState } from './liveState';

export type GoLiveKind = 'publish' | 'activate';

/** The automation row as the shell holds it: the live columns plus what keys the readiness cache. */
export type GoLiveRow = LiveRow & { id?: string | null; updatedAt?: unknown; description?: unknown };

export interface GoLiveDialogProps {
    automation: GoLiveRow | null;
    action: GoLiveKind;
    onCancel: () => void;
    onConfirm: () => void;
}

type T = ReturnType<typeof useTranslation>['t'];

/**
 * What pressing the button does, in one sentence, from what the server does
 * (routes/automation/activate.js): Publish makes the working copy the live
 * version; Activate on a never-live automation does that AND switches it on;
 * Activate on a paused one only switches the live version back on, and
 * changes saved since stay in the working copy.
 */
export function goLiveSentence(live: LiveState, action: GoLiveKind, t: T): string {
    const version = live.workingVersion ?? '';
    const liveVersion = live.liveVersion ?? '';
    if (action === 'publish') {
        return live.liveVersion == null
            ? t('automations.golive.what_publish_first', 'This makes v{version} the live version.', { version })
            : t('automations.golive.what_publish', 'v{live} is live. This makes v{version} live.', { live: liveVersion, version });
    }
    if (live.kind === 'never') {
        return t('automations.golive.what_first', 'This automation has never been live. This makes v{version} live and switches it on.', { version });
    }
    return live.pendingChanges > 0
        ? t('automations.golive.what_resume_pending', 'This switches the automation back on with v{live}. Your changes in v{version} stay in the working copy until you make them live.', { live: liveVersion, version })
        : t('automations.golive.what_resume', 'This switches the automation back on. Runs use v{live}, the live version.', { live: liveVersion });
}

/** A new version goes live with this action (so it should have been tested); switching a paused one back on does not. */
export function putsNewVersionLive(live: LiveState, action: GoLiveKind): boolean {
    return action === 'publish' || live.kind === 'never';
}

/**
 * Why the person has to say "anyway", or null when the last test passed.
 * Checks that could not be read count as "not tested": the dialog cannot
 * vouch for a test it did not see.
 */
function untestedReason(readiness: Readiness | undefined, failed: boolean, t: T, saved = true): string | null {
    if (!saved) return t('automations.golive.anyway_none', 'This automation has not been tested yet.');
    if (failed || !readiness) return t('automations.golive.anyway_unknown', 'The checks could not be loaded, so this version counts as not tested.');
    if (!readiness.lastTest) return t('automations.golive.anyway_none', 'This automation has not been tested yet.');
    if (!readiness.lastTest.ok) return t('automations.golive.anyway_failed', 'The last test failed.');
    return null;
}

function ChangesSection({ automationId, stamp, live }: { automationId: string; stamp: string; live: LiveState }) {
    const { t } = useTranslation();
    const diff = useWorkingVsLiveDiffQuery(automationId, stamp, true);
    const changes = diff.data?.changes ?? [];
    let body;
    if (diff.isError) body = <p role="alert" className="text-[var(--error)]">{t('automations.versions.diffFailed', 'The changes could not be loaded.')}</p>;
    else if (!diff.data) body = <p className="text-[var(--text-tertiary)]">{t('common.loading', 'Loading…')}</p>;
    else if (changes.length === 0) body = <p className="text-[var(--text-secondary)]">{t('automations.versions.noChanges', 'No changes that affect how it runs.')}</p>;
    else {
        body = (
            <div className="max-h-[32vh] overflow-auto" data-testid="golive-changes">
                <FieldDiffTable changes={changes} from={live.liveVersion ?? 0} to={live.workingVersion ?? 0} />
            </div>
        );
    }
    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="font-semibold">{t('automations.golive.changes_title', 'What changes')}</h3>
            {body}
        </section>
    );
}

function ChecksSection({ automationId, stamp, readiness, failed, loading, workingVersion }: {
    automationId: string; stamp: string; readiness: Readiness | undefined; failed: boolean; loading: boolean; workingVersion: number | null;
}) {
    const { t } = useTranslation();
    const check = useAiActCheck(aiActVisible(readiness) ? automationId : null, stamp);
    const tested = readiness?.lastTest?.version ?? null;
    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="font-semibold">{t('automations.golive.checks_title', 'Before it goes live')}</h3>
            {loading && <p className="text-[var(--text-tertiary)]">{t('automations.ready.loading', 'Checking…')}</p>}
            {failed && <p role="alert" className="text-[var(--error)]">{t('automations.golive.checks_failed', 'The checks could not be loaded.')}</p>}
            {readiness && <ReadinessChecklist items={readinessItems(readiness, t, check.data)} />}
            {tested != null && workingVersion != null && tested !== workingVersion && (
                <p className="text-[var(--text-secondary)]" data-testid="golive-tested-on">
                    {t('automations.golive.tested_on', 'The last test ran on v{tested}, not on v{version}.', { tested, version: workingVersion })}
                </p>
            )}
        </section>
    );
}

function AnywayBox({ reason, checked, onChange }: { reason: string; checked: boolean; onChange: (checked: boolean) => void }) {
    const { t } = useTranslation();
    return (
        <label className="flex items-start gap-2 rounded-lg border border-[var(--warning)] p-2.5">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
            <span>
                <span className="font-semibold">{t('automations.golive.anyway', 'Make it live anyway')}</span>
                <span className="block text-[var(--text-secondary)]">{reason}</span>
            </span>
        </label>
    );
}

/** The dialog's title and the word on its confirm button: "Make vN live" when a new version goes live, else "Activate". */
function goLiveWords(live: LiveState, newVersion: boolean, t: T): { title: string; confirm: string } {
    const version = live.workingVersion ?? '';
    return newVersion
        ? {
            title: t('automations.golive.title_publish', 'Make v{version} live?', { version }),
            confirm: t('automations.header.make_live', 'Make v{version} live', { version }),
        }
        : {
            title: t('automations.golive.title_activate', 'Switch this automation back on?'),
            confirm: t('automations.header.activate', 'Activate'),
        };
}

/** Everything the dialog shows, worked out from the row and the readiness answer. */
function useGoLiveState(automation: GoLiveRow | null, action: GoLiveKind) {
    const { t } = useTranslation();
    const id = automation?.id || null;
    // No server row yet: Activate saves it first, so it is a first go-live.
    const live = liveStateOf(id ? automation : { ...automation, neverLive: true });
    const stamp = readinessStamp(automation);
    const newVersion = putsNewVersionLive(live, action);
    const readiness = useReadiness(newVersion ? id : null, stamp);
    const loading = newVersion && !!id && readiness.isLoading;
    const reason = newVersion && !loading ? untestedReason(readiness.data, readiness.isError, t, !!id) : null;
    const words = goLiveWords(live, newVersion, t);
    const showChanges = action === 'publish' && live.liveVersion != null;
    return { live, id, stamp, newVersion, readiness, loading, reason, words, showChanges };
}

/**
 * The question in front of "Make vN live" and "Activate": what happens, what
 * changes against the live version, and how ready it is. When the last test
 * failed, never ran, or could not be read, the confirm button waits for an
 * explicit "anyway". The server decides nothing on a test result
 * (automation/goLive.js); this dialog only makes the choice a deliberate one.
 */
export default function GoLiveDialog({ automation, action, onCancel, onConfirm }: GoLiveDialogProps) {
    const { t } = useTranslation();
    const cancelRef = useRef<HTMLButtonElement | null>(null);
    const [anyway, setAnyway] = useState(false);
    const { live, id, stamp, newVersion, readiness, loading, reason, words, showChanges } = useGoLiveState(automation, action);

    return (
        <Modal
            open
            onClose={onCancel}
            size="auto"
            zIndex={1000}
            className="w-full max-w-[640px]"
            initialFocus={cancelRef}
            title={words.title}
            footer={(
                <div className="flex items-center justify-end gap-2">
                    <button ref={cancelRef} type="button" onClick={onCancel} className={SECONDARY_BTN}>{t('common.cancel', 'Cancel')}</button>
                    <button type="button" onClick={onConfirm} disabled={loading || (!!reason && !anyway)} className={PRIMARY_BTN} data-testid="golive-confirm">
                        {words.confirm}
                    </button>
                </div>
            )}
        >
            <div className="flex flex-col gap-4 text-xs text-[var(--text-primary)]">
                <p className="text-sm" data-testid="golive-what">{goLiveSentence(live, action, t)}</p>
                {id && showChanges && <ChangesSection automationId={id} stamp={stamp} live={live} />}
                {id && newVersion && (
                    <ChecksSection
                        automationId={id} stamp={stamp} readiness={readiness.data} failed={readiness.isError}
                        loading={loading} workingVersion={live.workingVersion}
                    />
                )}
                {reason && <AnywayBox reason={reason} checked={anyway} onChange={setAnyway} />}
            </div>
        </Modal>
    );
}
