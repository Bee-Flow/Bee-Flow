import { AlertTriangle } from 'lucide-react';
import React from 'react';
import ProjectBlueprintTab from './ProjectBlueprintTab';
import { useTranslation } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { Strip } from './solutionNotices';

/**
 * Packaging this Solution, as a dialog rather than a tab.
 *
 * The BODY is `ProjectBlueprintTab`, unchanged and imported: the "also keep it
 * on this instance" choice, the manifest's own contents summary, and — the
 * reason that screen exists — the list of what a Blueprint does NOT carry. That
 * honesty is the single most valuable thing on it, so it moves rather than
 * being reimplemented, and its nine pinned cases keep testing the same
 * component they always did.
 *
 * What the dialog adds is the two things a tab could not say:
 *
 *   - WHAT THE RECIPIENT WILL HAVE TO CONNECT THEMSELVES, before anything is
 *     written. The manifest reports `{ kind, count }` after an export; this
 *     shows the typed preview the completeness endpoint builds — the step, the
 *     layer and the author's own table key — so "you will have to pick a table
 *     again" becomes a sentence naming which step and which table.
 *   - THAT PUBLISHING IS CURRENTLY REFUSED, and why. In `publish` mode the
 *     dialog does not open at all while `blocked !== false`; the caller's
 *     button is disabled and this line is what it says when hovered.
 *
 * ── The list is only worth what the checks were ─────────────────────────────
 *
 * "Whoever installs it has to supply …" is drawn entirely from
 * `completeness.requires`, and an EMPTY dialog is what both "nothing needs
 * supplying" and "the checks never ran" look like. SolutionDetail drops the
 * previous answer on a failed fetch on purpose, so `completeness` arrives as
 * `null` far more often than it arrives partial — and that was the one state
 * with no caveat at all: the reader saw a preview with nothing in it and read
 * it as good news. So silence is earned by `complete === true` and by nothing
 * else; every other state says which one it is.
 *
 * `mode` is the whole difference between the two entry points. 'export' is a
 * download and offers the keep-here choice; 'publish' is "put it where
 * colleagues can install it", which IS keeping it here, so that choice is made
 * rather than asked.
 */

/** One typed requirement as a sentence. Never a person, never a credential. */
function requirementLine(item, t) {
    if (item.externalId) {
        return t('solutions.requires_external', '{kind} outside this Solution ({id})')
            .replace('{kind}', item.kind).replace('{id}', item.externalId);
    }
    const where = item.stepId
        ? t('solutions.requires_at_step', 'step {step}').replace('{step}', item.stepId)
        : '';
    const inRoutine = item.automationTitle
        ? t('solutions.requires_in', 'in {name}').replace('{name}', item.automationTitle)
        : '';
    if (item.kind === 'datatable') {
        const key = item.datatableKey
            ? t('solutions.requires_table_named', 'a table for "{key}"').replace('{key}', item.datatableKey)
            : t('solutions.requires_table', 'a table');
        return [key, where, inRoutine].filter(Boolean).join(' · ');
    }
    if (item.kind === 'connection') {
        return [t('solutions.requires_connection', 'a connection'), where, inRoutine].filter(Boolean).join(' · ');
    }
    if (item.kind === 'approver') {
        return [t('solutions.requires_approver', 'someone to approve'), where, inRoutine].filter(Boolean).join(' · ');
    }
    if (item.kind === 'knowledge_base') {
        return [t('solutions.requires_kb', 'a knowledge base'), where, inRoutine].filter(Boolean).join(' · ');
    }
    return [item.kind, where, inRoutine].filter(Boolean).join(' · ');
}

export function RequirementsPreview({ requires }) {
    const { t } = useTranslation();
    const items = requires?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    return (
        <div data-testid="solution-requires-preview">
            <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                {t('projects.blueprint_requires', 'Whoever installs it has to supply')}
            </h3>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={`${item.kind}-${item.stepId || item.externalId || i}`}
                        className="px-3 py-2 rounded-lg text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                        {requirementLine(item, t)}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function SolutionExportDialog({
    open,
    onClose,
    projectId,
    projectName,
    role,
    mode = 'export',
    completeness,
}) {
    const { t } = useTranslation();
    const publishing = mode === 'publish';

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            title={publishing
                ? t('solutions.publish_title', 'Publish this Solution')
                : t('solutions.export_title', 'Export this Solution')}
            description={publishing
                ? t('solutions.publish_intro', 'A published Solution is kept on this instance, so colleagues can install it without a file changing hands.')
                : undefined}
        >
            <div className="space-y-5">
                {/* The list is a preview, so it must not read as a verdict when
                    the checks did not run. Three states, three sentences. */}
                {!completeness && (
                    <Strip tone="var(--warning)" icon={AlertTriangle} testId="solution-export-unchecked">
                        {t('solutions.export_unchecked',
                            'The checks could not be run, so nothing below says what whoever installs this will have to supply.')}
                    </Strip>
                )}
                {completeness && completeness.complete !== true && (
                    <Strip tone="var(--warning)" icon={AlertTriangle} testId="solution-export-incomplete">
                        {t('solutions.export_incomplete',
                            'Part of this Solution could not be read, so what is listed below may be incomplete.')}
                    </Strip>
                )}

                <RequirementsPreview requires={completeness?.requires} />

                <ProjectBlueprintTab
                    projectId={projectId}
                    projectName={projectName}
                    role={role}
                    forceKeepHere={publishing}
                />
            </div>
        </Modal>
    );
}
