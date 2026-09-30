// The right half of the history panel: one selected version, what it changed
// (compared with the version before it, with the current state, or with any
// other version), and what an editor can do with it: name it, restore it.
//
// A restore always goes through a confirmation that says what will happen:
// the version becomes the current content for everyone, and the content it
// replaces is kept as a version first.

import { ArrowLeft, Pencil, RotateCcw } from 'lucide-react';
import React, { useState } from 'react';
import {
    CURRENT, useRenameVersion, useRestoreVersion, useVersionQuery, type VersionContent, type VersionDetail as VersionDetailData, type VersionMeta,
} from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';
import ConfirmDialog from '../shared/ConfirmDialog';
import NameVersionForm from './NameVersionForm';
import VersionCompare from './VersionCompare';
import { AiChip, AvatarStack } from './VersionList';
import { contributorLine, contributorSummary, sourceLabel, versionErrorText, type PeopleNames, type TFn } from './versionText';

export interface VersionDetailProps {
    baseUrl: string;
    version: VersionMeta;
    /** The versions loaded in the list (newest first), to compare with. */
    versions: VersionMeta[];
    /** What to compare the selected version with: another version id, or 'current'. */
    compareWith: string | null;
    onCompareWith: (ref: string | null) => void;
    canEdit: boolean;
    people: PeopleNames;
    currentUserId?: string | null;
    expectedVersion?: number | string | null;
    renderContent?: (content: VersionContent, version: VersionDetailData) => React.ReactNode;
    onRestored: (current: unknown) => void;
    onBack: () => void;
}

const BUTTON = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';

const timeOf = (v: { createdAt: string } | undefined) => (v ? Date.parse(v.createdAt) || 0 : Number.POSITIVE_INFINITY);

/** Older side first: 'current' is always the newest. */
function orderPair(versions: VersionMeta[], a: string, b: string): [string, string] {
    const at = (ref: string) => (ref === CURRENT ? Number.POSITIVE_INFINITY : timeOf(versions.find((v) => v.id === ref)));
    return at(a) <= at(b) ? [a, b] : [b, a];
}

/** The choices of "Compare with": the version before, now, then every other loaded version. */
function compareOptions(t: TFn, version: VersionMeta, versions: VersionMeta[], previous: VersionMeta | null) {
    return [
        ...(previous ? [{ value: previous.id, label: t('versions.detail.with_previous', 'the version before it') }] : []),
        { value: CURRENT, label: t('versions.detail.with_current', 'the current content') },
        ...versions
            .filter((v) => v.id !== version.id && v.id !== previous?.id)
            .map((v) => ({ value: v.id, label: `${v.name || sourceLabel(t, String(v.source))} · ${new Date(v.createdAt).toLocaleString()}` })),
    ];
}

function Preview({ baseUrl, version, renderContent }: {
    baseUrl: string;
    version: VersionMeta;
    renderContent: NonNullable<VersionDetailProps['renderContent']>;
}) {
    const { t } = useTranslation();
    const detail = useVersionQuery(baseUrl, version.id);
    if (detail.isPending) return <p role="status" className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('versions.loading_version', 'Loading this version…')}</p>;
    if (detail.isError) return <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{versionErrorText(t, detail.error)}</p>;
    return <div data-testid="version-preview">{renderContent(detail.data.content, detail.data)}</div>;
}

/** Title, when and who, and the editor's actions (name, restore). */
function DetailHeader({ baseUrl, version, canEdit, people, currentUserId, restoring, onRestore, onBack }: {
    baseUrl: string;
    version: VersionMeta;
    canEdit: boolean;
    people: PeopleNames;
    currentUserId?: string | null;
    restoring: boolean;
    onRestore: () => void;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const [renaming, setRenaming] = useState(false);
    const rename = useRenameVersion(baseUrl);
    const line = contributorLine(t, version.contributors, people, currentUserId);
    const at = new Date(version.createdAt);
    return (
        <>
            <button type="button" onClick={onBack} className="min-[900px]:hidden inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                {t('versions.detail.back', 'All versions')}
            </button>
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <p className="m-0 text-[14px] font-semibold text-[var(--text-primary)] truncate" data-testid="version-detail-title">
                        {version.name || sourceLabel(t, String(version.source))}
                    </p>
                    <p className="m-0 mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                        {!Number.isNaN(at.getTime()) && <time dateTime={version.createdAt}>{at.toLocaleString()}</time>}
                        {line.people.length > 0 && <AvatarStack names={line.people.map((p) => p.name)} />}
                        <span className="truncate">{contributorSummary(t, line)}</span>
                        {line.ai && <AiChip />}
                    </p>
                </div>
                {canEdit && !renaming && (
                    <button type="button" className={BUTTON} onClick={() => setRenaming(true)} data-testid="version-rename">
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                        {version.name ? t('versions.detail.rename', 'Rename') : t('versions.detail.name', 'Name')}
                    </button>
                )}
                {canEdit && (
                    <button type="button" className={BUTTON} onClick={onRestore} disabled={restoring} data-testid="version-restore">
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('versions.detail.restore', 'Restore')}
                    </button>
                )}
            </div>
            {renaming && (
                <NameVersionForm
                    initialName={version.name}
                    allowClear
                    busy={rename.isPending}
                    error={rename.error ? versionErrorText(t, rename.error) : null}
                    onCancel={() => { setRenaming(false); rename.reset(); }}
                    onSubmit={(name) => rename.mutate({ ref: version.id, name }, { onSuccess: () => setRenaming(false) })}
                    testId="version-rename-form"
                />
            )}
        </>
    );
}

export default function VersionDetail({
    baseUrl, version, versions, compareWith, onCompareWith, canEdit, people, currentUserId, expectedVersion, renderContent, onRestored, onBack,
}: VersionDetailProps) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const [preview, setPreview] = useState(false);
    const restore = useRestoreVersion(baseUrl);

    const index = versions.findIndex((v) => v.id === version.id);
    const previous = index >= 0 ? versions[index + 1] || null : null;
    // The first version has nothing before it: it is compared with now.
    const other = compareWith || previous?.id || CURRENT;
    const pair = orderPair(versions, other, version.id);

    const doRestore = async () => {
        try {
            const out = await restore.mutateAsync({ ref: version.id, expectedVersion });
            onRestored(out.current);
        } catch {
            // Said below the header; the dialog closes either way.
        } finally {
            setConfirming(false);
        }
    };

    return (
        <div className="flex flex-col min-h-0 h-full" data-testid="version-detail">
            <div className="px-4 pt-3 pb-2 border-b border-[var(--border-subtle)] space-y-2">
                <DetailHeader
                    baseUrl={baseUrl}
                    version={version}
                    canEdit={canEdit}
                    people={people}
                    currentUserId={currentUserId}
                    restoring={restore.isPending}
                    onRestore={() => setConfirming(true)}
                    onBack={onBack}
                />
                {restore.isError && <p role="alert" className="m-0 text-[12px] text-[var(--error-ink)]" data-testid="version-restore-error">{versionErrorText(t, restore.error)}</p>}
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                    <label htmlFor="version-compare-with">{t('versions.detail.compare_with', 'Compare with')}</label>
                    <select
                        id="version-compare-with"
                        value={other}
                        onChange={(e) => { setPreview(false); onCompareWith(e.target.value); }}
                        className="h-7 max-w-[16rem] px-1.5 rounded-md text-[12px] border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                        data-testid="version-compare-with"
                    >
                        {compareOptions(t, version, versions, previous).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {renderContent && (
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} className="accent-[var(--accent-primary)]" />
                            {t('versions.detail.preview', 'Show as it looked')}
                        </label>
                    )}
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3">
                {preview && renderContent
                    ? <Preview baseUrl={baseUrl} version={version} renderContent={renderContent} />
                    : <VersionCompare key={`${pair[0]}>${pair[1]}`} baseUrl={baseUrl} fromRef={pair[0]} toRef={pair[1]} />}
            </div>
            <ConfirmDialog
                open={confirming}
                title={t('versions.restore.title', 'Restore this version?')}
                description={t('versions.restore.body', 'This version becomes the current content for everyone who works on it. The current content is kept as a version first, so nothing is lost and you can go back to it.')}
                confirmLabel={t('versions.restore.confirm', 'Restore')}
                cancelLabel={t('versions.cancel', 'Cancel')}
                onConfirm={doRestore}
                onCancel={() => setConfirming(false)}
            />
        </div>
    );
}
