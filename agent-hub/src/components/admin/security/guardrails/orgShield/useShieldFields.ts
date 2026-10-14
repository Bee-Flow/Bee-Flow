import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ShieldFields, ToolPiiPolicy } from './orgShieldDoc';
import type { CustomDataType, TestsDoc } from './ownData/ownDataModel';

type Setter<K extends keyof ShieldFields> = Dispatch<SetStateAction<ShieldFields[K]>>;

/** The form's fields and their setters, as `useOrgShield().fields` hands them to the panes. */
export interface ShieldFieldBindings extends Omit<ShieldFields, 'piiFailureMode'> {
    setEnabled: Setter<'enabled'>;
    setEuModeEnabled: Setter<'euModeEnabled'>;
    setWebSearchGuard: Setter<'webSearchGuard'>;
    setDisableSearchOnUpload: Setter<'disableSearchOnUpload'>;
    setMonitorIntegrations: Setter<'monitorIntegrations'>;
    setApplyToAutomations: Setter<'applyToAutomations'>;
    setDlpEnabled: Setter<'dlpEnabled'>;
    setDlpMode: Setter<'dlpMode'>;
    setDlpAlwaysReview: Setter<'dlpAlwaysReview'>;
    setCustomDataTypes: Setter<'customDataTypes'>;
    setCustomDataTests: Setter<'customDataTests'>;
    setPiiAllowTerms: Setter<'piiAllowTerms'>;
    setPiiAllowPublicOrgs: Setter<'piiAllowPublicOrgs'>;
    setPiiCategories: Setter<'piiCategories'>;
    setPiiConfidenceThreshold: Setter<'piiConfidenceThreshold'>;
    setPiiAction: Setter<'piiAction'>;
    setShowRawPayload: Setter<'showRawPayload'>;
    setScanKnowledgeBases: Setter<'scanKnowledgeBases'>;
}

export interface ShieldFieldsState {
    /** Every field, for buildPayload and the dirty comparison. */
    values: ShieldFields;
    fields: ShieldFieldBindings;
    /** Push one normalised document into the form (load and discard share it). */
    applyFields: (f: ShieldFields) => void;
    /** Toggle one PII category in a tool-class block list (external | internal). */
    toggleToolPiiCat: (cls: keyof ToolPiiPolicy, id: string, checked: boolean) => void;
    setToolPiiCats: (cls: keyof ToolPiiPolicy, ids: string[]) => void;
}

/** The Privacy Shield form state: one useState per field, in the order the form was written. */
export default function useShieldFields(): ShieldFieldsState {
    const [enabled, setEnabled] = useState(false);
    const [euModeEnabled, setEuModeEnabled] = useState(false);
    const [webSearchGuard, setWebSearchGuard] = useState(false);
    const [disableSearchOnUpload, setDisableSearchOnUpload] = useState(false);
    const [monitorIntegrations, setMonitorIntegrations] = useState(false);
    const [applyToAutomations, setApplyToAutomations] = useState(true);
    const [dlpEnabled, setDlpEnabled] = useState(false);
    const [dlpMode, setDlpMode] = useState<ShieldFields['dlpMode']>('ask');
    const [dlpAlwaysReview, setDlpAlwaysReview] = useState(false);
    // The org's own kinds of data ("Your own data"), and their test sets.
    // Tests are `null` when the server did not send them (not an admin, or no
    // licence): then they are left out of the save entirely, never emptied.
    const [customDataTypes, setCustomDataTypes] = useState<CustomDataType[]>([]);
    const [customDataTests, setCustomDataTests] = useState<TestsDoc | null>(null);
    // Terms that must NEVER be redacted. Previously loaded by nobody and
    // destroyed on every save.
    const [piiAllowTerms, setPiiAllowTerms] = useState<string[]>([]);
    // `!== false`: an absent value means ON, matching the server and the
    // runtime matcher. Defaulting to `false` here would render "off" for a
    // list that is actually active.
    const [piiAllowPublicOrgs, setPiiAllowPublicOrgs] = useState(true);
    const [toolPiiPolicy, setToolPiiPolicy] = useState<ToolPiiPolicy>({
        external: { blockCategories: [] },
        internal: { blockCategories: [] },
    });
    const [piiCategories, setPiiCategories] = useState<string[]>([]);
    const [piiConfidenceThreshold, setPiiConfidenceThreshold] = useState(0.7);
    const [piiAction, setPiiAction] = useState('block');
    // Not exposed in the UI: stays at its safe default so a degraded detector
    // never silently sends unmasked text to the model (BFSF-269).
    const [piiFailureMode, setPiiFailureMode] = useState<ShieldFields['piiFailureMode']>('fail_closed');
    const [scanKnowledgeBases, setScanKnowledgeBases] = useState(true);
    const [showRawPayload, setShowRawPayload] = useState(false);

    const applyFields = useCallback((f: ShieldFields) => {
        setEnabled(f.enabled);
        setEuModeEnabled(f.euModeEnabled);
        setWebSearchGuard(f.webSearchGuard);
        setDisableSearchOnUpload(f.disableSearchOnUpload);
        setMonitorIntegrations(f.monitorIntegrations);
        setApplyToAutomations(f.applyToAutomations);
        setDlpEnabled(f.dlpEnabled);
        setDlpMode(f.dlpMode);
        setDlpAlwaysReview(f.dlpAlwaysReview);
        setCustomDataTypes(f.customDataTypes);
        setCustomDataTests(f.customDataTests);
        setPiiAllowTerms(f.piiAllowTerms);
        setPiiAllowPublicOrgs(f.piiAllowPublicOrgs);
        setToolPiiPolicy(f.toolPiiPolicy);
        setPiiCategories(f.piiCategories);
        setPiiConfidenceThreshold(f.piiConfidenceThreshold);
        setPiiAction(f.piiAction);
        setPiiFailureMode(f.piiFailureMode);
        setScanKnowledgeBases(f.scanKnowledgeBases);
        setShowRawPayload(f.showRawPayload);
    }, []);

    const toggleToolPiiCat = useCallback((cls: keyof ToolPiiPolicy, id: string, checked: boolean) => setToolPiiPolicy(prev => ({
        ...prev,
        [cls]: {
            blockCategories: checked
                ? [...new Set([...(prev[cls]?.blockCategories || []), id])]
                : (prev[cls]?.blockCategories || []).filter(x => x !== id),
        },
    })), []);

    const setToolPiiCats = useCallback((cls: keyof ToolPiiPolicy, ids: string[]) => setToolPiiPolicy(prev => ({
        ...prev,
        [cls]: { blockCategories: ids },
    })), []);

    const values: ShieldFields = {
        enabled, euModeEnabled, webSearchGuard, disableSearchOnUpload,
        monitorIntegrations, applyToAutomations, dlpEnabled, dlpMode, dlpAlwaysReview,
        customDataTypes, customDataTests, piiAllowTerms, piiAllowPublicOrgs, toolPiiPolicy,
        piiCategories, piiConfidenceThreshold, piiAction, piiFailureMode, showRawPayload,
        scanKnowledgeBases,
    };
    const fields: ShieldFieldBindings = {
        enabled, setEnabled,
        euModeEnabled, setEuModeEnabled,
        webSearchGuard, setWebSearchGuard,
        disableSearchOnUpload, setDisableSearchOnUpload,
        monitorIntegrations, setMonitorIntegrations,
        applyToAutomations, setApplyToAutomations,
        dlpEnabled, setDlpEnabled,
        dlpMode, setDlpMode,
        dlpAlwaysReview, setDlpAlwaysReview,
        customDataTypes, setCustomDataTypes,
        customDataTests, setCustomDataTests,
        piiAllowTerms, setPiiAllowTerms,
        piiAllowPublicOrgs, setPiiAllowPublicOrgs,
        toolPiiPolicy,
        piiCategories, setPiiCategories,
        piiConfidenceThreshold, setPiiConfidenceThreshold,
        piiAction, setPiiAction,
        showRawPayload, setShowRawPayload,
        scanKnowledgeBases, setScanKnowledgeBases,
    };
    return { values, fields, applyFields, toggleToolPiiCat, setToolPiiCats };
}
