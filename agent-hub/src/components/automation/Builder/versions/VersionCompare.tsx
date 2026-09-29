import { useId, useState } from 'react';
import { Eye, Flag, History } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import {
    useFieldDiffQuery, useNameVersionMutation, useVersionDefinitionQuery, type VersionRow,
} from '../../../../api/queries/automation/versions';
import VersionChanges from './VersionChanges';
import VersionMiniCanvas from './VersionMiniCanvas';
import VersionNameForm from './VersionNameForm';
import { describeVersion } from './versionText';

interface Props {
    automationId: string;
    rows: VersionRow[];
    selected: VersionRow;
    restoring: boolean;
    onRestore: (target: VersionRow) => void;
    onOpen: (row: VersionRow) => void;
}

/**
 * The version to compare against by default: the live one, or else the one
 * just before.
 */
function defaultCompareTarget(rows: VersionRow[], selected: VersionRow): VersionRow | null {
    const live = rows.find((r) => r.isLive);
    if (live && live.id !== selected.id) return live;
    return rows.find((r) => r.version < selected.version) ?? null;
}

/**
 * The target a restore puts back. From the working copy that is the version
 * compared against ("Restore to v3"); from any other version, that version.
 */
function restoreTarget(selected: VersionRow, compare: VersionRow | null): VersionRow | null {
    return selected.isEditing ? compare : selected;
}

const OUTLINE_BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-60';

function CompareSelect({ id, others, value, onChange }: {
    id: string; others: VersionRow[]; value: string | null; onChange: (id: string | null) => void;
}) {
    const { t } = useTranslation();
    // The first version has nothing to compare with: no dangling label either.
    if (!others.length) return null;
    return (
        <>
            <label htmlFor={id} className="text-[var(--text-tertiary)]">
                {t('routines.versions.comparedWith', 'Compared with')}
            </label>
            <select
                id={id}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value || null)}
                className="px-2.5 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]"
            >
                {others.map((r) => (
                    <option key={r.id} value={r.id}>
                        {r.isLive ? t('routines.versions.compareLive', 'v{version} · live', { version: r.version }) : `v${r.version}`}
                    </option>
                ))}
            </select>
        </>
    );
}

/** The right column: what this version changed, as a strip and a per-setting table. */
export default function VersionCompare({ automationId, rows, selected, restoring, onRestore, onOpen }: Props) {
    const { t } = useTranslation();
    const selectId = useId();
    const [compareId, setCompareId] = useState<string | null>(() => defaultCompareTarget(rows, selected)?.id ?? null);
    const [naming, setNaming] = useState(false);
    const compare = rows.find((r) => r.id === compareId) ?? null;
    const nameMut = useNameVersionMutation(automationId);
    const def = useVersionDefinitionQuery(automationId, selected.id);
    const diff = useFieldDiffQuery(automationId, selected.version, compare?.version ?? null);
    const target = restoreTarget(selected, compare);
    const heading = t('routines.versions.heading', 'v{version} · {title}', {
        version: selected.version, title: selected.name ?? describeVersion(selected, t),
    });

    return (
        // The pane scrolls; its content stops at 1600px so on an ultrawide the
        // step names stay within reach of their values.
        <div className="min-w-0 min-h-0 overflow-y-auto custom-scrollbar px-7 py-5 text-[12px]">
            <div className="w-full max-w-[1600px] flex flex-col gap-4">
                {/* The heading gets its own line (a long change summary wraps
                    instead of shoving the controls around); the comparison
                    and the next moves share the line below and wrap together. */}
                <div className="flex flex-col gap-2">
                    <h2 className="text-[15px] font-semibold text-[var(--text-primary)] line-clamp-2 wrap-anywhere" title={heading}>{heading}</h2>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                        <CompareSelect id={selectId} others={rows.filter((r) => r.id !== selected.id)} value={compareId} onChange={setCompareId} />
                        <div className="ml-auto flex flex-wrap gap-1.5">
                            <button type="button" className={OUTLINE_BTN} onClick={() => setNaming((n) => !n)} aria-expanded={naming}>
                                <Flag size={12} />
                                {selected.name ? t('routines.versions.rename', 'Rename') : t('routines.versions.nameIt', 'Name it')}
                            </button>
                            <button type="button" className={OUTLINE_BTN} onClick={() => onOpen(selected)}>
                                <Eye size={12} />
                                {t('routines.versions.openReadOnly', 'Open (read-only)')}
                            </button>
                            {target && !target.isEditing && (
                                <button type="button" className={OUTLINE_BTN} disabled={restoring} onClick={() => onRestore(target)}>
                                    <History size={12} />
                                    {t('routines.versions.restoreTo', 'Restore to v{version}', { version: target.version })}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {naming && (
                    <VersionNameForm
                        initial={selected.name ?? ''}
                        busy={nameMut.isPending}
                        error={nameMut.isError ? t('routines.versions.nameFailed', 'The name could not be saved.') : null}
                        onCancel={() => setNaming(false)}
                        onSave={(name) => nameMut.mutate({ version: selected.version, name }, { onSuccess: () => setNaming(false) })}
                    />
                )}

                <VersionMiniCanvas
                    definition={def.data}
                    added={diff.data?.stepIds.added ?? []}
                    changed={diff.data?.stepIds.changed ?? []}
                />

                <VersionChanges selected={selected} compare={compare} diff={diff} />
            </div>
        </div>
    );
}
