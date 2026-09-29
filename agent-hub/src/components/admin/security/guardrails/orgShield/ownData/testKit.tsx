import React, { useState } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { withQueryClient } from '../../../../../../test/queryWrapper';
import type { ToolPiiPolicy } from '../orgShieldDoc';
import type { CustomDataType, TestsDoc } from './ownDataModel';
import { toggleId } from './ownDataModel';
import type { OwnDataFields } from './OwnDataTab';
import OwnDataTab from './OwnDataTab';

/**
 * Test-only kit for the "Your own data" suites: a translator that fills in
 * `{params}` (a mock that drops them tests the mock, not the screen), and a
 * harness that holds the shield form's state the way useOrgShield does, so a
 * test can read back exactly what the tab wrote into the form.
 */

export const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let out = hasFallback ? (fallbackOrParams as string) : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    }
    return out;
};

export interface HarnessInit {
    types?: CustomDataType[];
    tests?: TestsDoc | null;
    piiCategories?: string[];
    toolPiiPolicy?: ToolPiiPolicy;
    allowTerms?: string[];
    allowPublicOrgs?: boolean;
    applyToAutomations?: boolean;
}

export interface HarnessProps {
    init?: HarnessInit;
    licensed?: boolean;
    canUseWebSearchGuard?: boolean;
    guard?: { configured: boolean; reachable: boolean } | null;
    readOnly?: boolean;
    typeErrors?: { id: string; message?: string }[];
    /** Receives the form on every render, so a test can assert on the latest. */
    onForm?: (f: OwnDataFields) => void;
}

function Harness({
    init = {}, licensed = true, canUseWebSearchGuard = true, guard = { configured: true, reachable: true }, readOnly = false, typeErrors = [], onForm,
}: HarnessProps) {
    const [types, setTypes] = useState<CustomDataType[]>(init.types || []);
    const [tests, setTests] = useState<TestsDoc | null>(init.tests === undefined ? {} : init.tests);
    const [cats, setCats] = useState<string[]>(init.piiCategories || ['Email']);
    const [tpp, setTpp] = useState<ToolPiiPolicy>(init.toolPiiPolicy || { external: { blockCategories: [] }, internal: { blockCategories: [] } });
    const [allowTerms, setAllowTerms] = useState<string[]>(init.allowTerms || []);
    const [allowPublic, setAllowPublic] = useState<boolean>(init.allowPublicOrgs !== false);
    const f: OwnDataFields = {
        customDataTypes: types,
        setCustomDataTypes: setTypes,
        customDataTests: tests,
        setCustomDataTests: setTests,
        piiCategories: cats,
        setPiiCategories: setCats,
        toolPiiPolicy: tpp,
        piiAllowTerms: allowTerms,
        setPiiAllowTerms: setAllowTerms,
        piiAllowPublicOrgs: allowPublic,
        setPiiAllowPublicOrgs: setAllowPublic,
        applyToAutomations: init.applyToAutomations,
    };
    onForm?.(f);
    return (
        <OwnDataTab
            f={f}
            orgId="org-1"
            licence={{ canUseCustomData: licensed, canUseWebSearchGuard, upgradeUrl: 'https://example.test/upgrade' }}
            guard={guard}
            readOnly={readOnly}
            typeErrors={typeErrors}
            toggleToolPiiCat={(cls, id, on) => setTpp(p => ({ ...p, [cls]: { blockCategories: toggleId(p[cls].blockCategories, id, on) } }))}
            setToolPiiCats={(cls, ids) => setTpp(p => ({ ...p, [cls]: { blockCategories: ids } }))}
            t={t}
        />
    );
}

/** The tab, inside its own QueryClient, with a way to read the form back. */
export function renderableTab(props: HarnessProps = {}) {
    const form: { current: OwnDataFields | null } = { current: null };
    const ui = withQueryClient(<Harness {...props} onForm={(f) => { form.current = f; props.onForm?.(f); }} />);
    return { ui, form };
}

export const WORDS_TYPE: CustomDataType = {
    id: 'cdt_0000000001',
    name: 'Product names',
    description: '',
    method: 'words',
    tokenKey: 'product',
    origin: 'created',
    words: { values: ['Falcon', 'Heron'], caseSensitive: false, wholeWord: true },
    quality: { found: 19, total: 20, falseAlarms: 1, sentences: 24 },
};

export const LEGACY_TYPE: CustomDataType = {
    id: 'cdt_0000000002',
    name: 'Old codename',
    description: '',
    method: 'words',
    tokenKey: 'customterm',
    origin: 'migrated',
    legacy: true,
    words: { values: ['AURORA'], caseSensitive: false, wholeWord: true },
};
