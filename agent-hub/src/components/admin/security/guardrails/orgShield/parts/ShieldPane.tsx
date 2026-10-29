import ActivityTab from '../activity/ActivityTab';
import type useShieldEvidence from '../activity/useShieldEvidence';
import type { derivePosture } from '../orgShieldPosture';
import { builtInOnly } from '../ownData/ownDataModel';
import type { TypeErrorEntry } from '../ownData/OwnDataList';
import OwnDataTab from '../ownData/OwnDataTab';
import { SHIELD_PANE } from '../shieldLayout';
import ChecksTab from '../tabs/ChecksTab';
import DetectionTab from '../tabs/DetectionTab';
import OverviewTab from '../tabs/OverviewTab';
import type useOrgShield from '../useOrgShield';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { useLicenseContext } from '@/components/licensing/LicenseContext';

type Shield = ReturnType<typeof useOrgShield>;
type LicenceContext = ReturnType<typeof useLicenseContext>;

interface ShieldPaneProps {
    tab: string;
    f: Shield['fields'];
    posture: ReturnType<typeof derivePosture>;
    guard: Shield['guardStatus'];
    meta: Shield['meta'];
    readOnly: boolean;
    evidence: ReturnType<typeof useShieldEvidence>;
    showActivity: boolean;
    showActivityTab: boolean;
    licence: { canTokenizePii: boolean; canUseWebSearchGuard: boolean; canUseCustomData: boolean; upgradeUrl: LicenceContext['upgradeUrl'] };
    env: { hasEuModelsConfigured: Shield['hasEuModelsConfigured']; hasWebSearchEnabled: Shield['hasWebSearchEnabled'] };
    t: TranslateFn;
    onGoTo: (id: string) => void;
    onDiagnoseGuard: () => void;
    onOpenCompliance: () => void;
    categories: Shield['categories'];
    orgId: Shield['selectedOrgId'];
    typeErrors: TypeErrorEntry[];
    toggleToolPiiCat: Shield['toggleToolPiiCat'];
    setToolPiiCats: Shield['setToolPiiCats'];
    canSeeActivity: boolean;
    upgradeUrl: LicenceContext['upgradeUrl'];
    saved: Shield['saved'];
}

/** The pane of the active step, capped and centred (see shieldLayout.ts). */
export default function ShieldPane({
    tab, f, posture, guard, meta, readOnly, evidence, showActivity, showActivityTab, licence, env, t, onGoTo,
    onDiagnoseGuard, onOpenCompliance, categories, orgId, typeErrors, toggleToolPiiCat, setToolPiiCats, canSeeActivity, upgradeUrl, saved,
}: ShieldPaneProps) {
    return (

            <div className={SHIELD_PANE}>
            {tab === 'overview' && (
                <OverviewTab
                    f={f}
                    posture={posture}
                    guard={guard}
                    meta={meta}
                    readOnly={readOnly}
                    evidence={evidence}
                    showActivity={showActivity}
                    licence={licence}
                    t={t}
                    onGoTo={onGoTo}
                    onDiagnoseGuard={onDiagnoseGuard}
                    onOpenCompliance={onOpenCompliance}
                />
            )}
            {tab === 'detection' && (
                <DetectionTab
                    f={f}
                    categories={categories}
                    readOnly={readOnly}
                    licence={licence}
                    evidence={evidence}
                    toggleToolPiiCat={toggleToolPiiCat}
                    onGoTo={onGoTo}
                    t={t}
                />
            )}
            {tab === 'owndata' && (
                <OwnDataTab
                    f={f}
                    orgId={orgId}
                    licence={licence}
                    guard={guard}
                    readOnly={readOnly}
                    typeErrors={typeErrors}
                    toggleToolPiiCat={toggleToolPiiCat}
                    setToolPiiCats={setToolPiiCats}
                    t={t}
                />
            )}
            {(tab === 'processing' || tab === 'outbound') && (
                <ChecksTab
                    step={tab}
                    f={f}
                    readOnly={readOnly}
                    licence={licence}
                    env={env}
                    evidence={evidence}
                    onGoTo={onGoTo}
                    t={t}
                />
            )}
            {tab === 'activity' && showActivityTab && (
                <ActivityTab
                    t={t}
                    shieldEnabled={!!f.enabled}
                    licensed={canSeeActivity}
                    upgradeUrl={upgradeUrl}
                    onGoTo={onGoTo}
                    toolHoldBack={{
                        // The saved policy: the findings describe what produced the data.
                        held: builtInOnly((saved || f).toolPiiPolicy?.external?.blockCategories).length,
                        total: categories.length,
                    }}
                />
            )}
            </div>
    );
}
