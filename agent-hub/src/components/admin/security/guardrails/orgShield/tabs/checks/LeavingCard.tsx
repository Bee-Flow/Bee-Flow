import React from 'react';

import { EVIDENCE_DAYS, type ShieldEvidence } from '../../activity/useShieldEvidence';
import LicenceLock from '../../parts/LicenceLock';
import ToggleCard, { ROW_CLASS, ROW_COLS, ROW_DESC, ROW_TITLE } from '../../parts/ToggleCard';
import { CheckCard } from './CheckCard';
import { toolGapCount } from './checksModel';
import type { ChecksEnv, ChecksFields, ChecksLicence, GoTo, TranslateFn } from './checksTypes';
import { LastCheckRow } from './LastCheckRow';
import { ToolGapNote } from './ToolGapNote';

/**
 * Check ②: everything that applies only on the way OUT of the organisation.
 *
 * Rows whose feature is not set up on this server (no EU models, no search
 * provider) are left out rather than shown as switches that would do nothing.
 */

/** "Protect web searches" on a plan without it: the same row, locked. */
function LockedWebGuardRow({ upgradeUrl, t }: { upgradeUrl?: string; t: TranslateFn }) {
    return (
        <div className={`${ROW_CLASS} ${ROW_COLS.plain}`}>
            <div className="min-w-0 col-span-full">
                <p className={`${ROW_TITLE} flex items-center gap-2`}>
                    {t('admin.shield_web_guard', 'Protect web searches')}
                    <span className="text-[10px] font-semibold px-1.5 py-px rounded-full border border-[var(--border-default)] text-[var(--text-secondary)]">
                        {t('license.enterprise', 'Enterprise')}
                    </span>
                </p>
                <p className={`${ROW_DESC} mb-1.5`}>
                    {t('admin.shield_web_guard_desc', 'Stop search terms that contain personal data from being sent to an outside search engine.')}
                </p>
                <LicenceLock upgradeUrl={upgradeUrl} t={t}>
                    {t('admin.shield_web_guard_locked', 'Protecting web searches is an Enterprise feature.')}
                </LicenceLock>
            </div>
        </div>
    );
}

function EuDescription({ t }: { t: TranslateFn }) {
    return (
        <>
            {t('shield_checks.eu_desc_lead', 'Chats only go to AI models hosted in the EU (set up under AI Config → Chat Models). Covers')}{' '}
            <strong className="font-semibold text-[var(--text-primary)]">{t('shield_checks.eu_desc_bold', 'models only')}</strong>{' '}
            {t('shield_checks.eu_desc_tail', '— connected apps such as Gmail follow the tool columns.')}
        </>
    );
}

function SearchRows({ f, readOnly, licence, t }: {
    f: ChecksFields;
    readOnly: boolean;
    licence: ChecksLicence;
    t: TranslateFn;
}) {
    return (
        <>
            {licence.canUseWebSearchGuard ? (
                <ToggleCard
                    title={t('admin.shield_web_guard', 'Protect web searches')}
                    description={t('admin.shield_web_guard_desc', 'Stop search terms that contain personal data from being sent to an outside search engine.')}
                    checked={f.webSearchGuard}
                    onChange={f.setWebSearchGuard}
                    disabled={readOnly}
                />
            ) : (
                <LockedWebGuardRow upgradeUrl={licence.upgradeUrl} t={t} />
            )}
            <ToggleCard
                title={t('admin.shield_search_upload', 'No web search while a file is attached')}
                description={t('shield_checks.search_upload_desc', 'So nothing from an attached document ends up in a search box.')}
                checked={f.disableSearchOnUpload}
                onChange={f.setDisableSearchOnUpload}
                disabled={readOnly}
            />
        </>
    );
}

export function LeavingCard({
    f, readOnly, licence, env, evidence, onGoTo, t,
}: {
    f: ChecksFields;
    readOnly: boolean;
    licence: ChecksLicence;
    env: ChecksEnv;
    evidence: ShieldEvidence | null;
    onGoTo?: GoTo;
    t: TranslateFn;
}) {
    return (
        <CheckCard
            n={2}
            title={t('shield_checks.leaving_title', 'Before it leaves your organisation')}
            subtitle={t('shield_checks.leaving_sub', 'only for an AI outside your organisation · the only step where people decide')}
            footer={(
                <ToolGapNote
                    count={toolGapCount(evidence)}
                    days={evidence?.days ?? EVIDENCE_DAYS}
                    onGoTo={onGoTo}
                    t={t}
                />
            )}
        >
            <LastCheckRow f={f} readOnly={readOnly} t={t} />
            {env.hasEuModelsConfigured && (
                <ToggleCard
                    title={t('admin.shield_eu_models', 'Use only AI hosted in the EU')}
                    description={<EuDescription t={t} />}
                    checked={f.euModeEnabled}
                    onChange={f.setEuModeEnabled}
                    disabled={readOnly}
                />
            )}
            {env.hasWebSearchEnabled && <SearchRows f={f} readOnly={readOnly} licence={licence} t={t} />}
            <ToggleCard
                title={t('admin.shield_integ_monitor', 'Check connected-app traffic for personal data')}
                description={t('shield_checks.integ_monitor_desc', 'Every connected-app call is always logged. This also checks its content, so the reports can show what kind of data left.')}
                checked={f.monitorIntegrations}
                onChange={f.setMonitorIntegrations}
                disabled={readOnly}
            />
        </CheckCard>
    );
}

export default LeavingCard;
