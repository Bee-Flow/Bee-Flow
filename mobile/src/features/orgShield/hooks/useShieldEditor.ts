/**
 * One dirty draft of the org's shield across all tabs — the phone's
 * useOrgShield.js. The loaded document is kept whole and every save is laid
 * over it (model/fields.ts buildPayload), so keys this screen never edits
 * survive. "Dirty" compares the payload with the payload at load, so what
 * changed and what would be sent can never disagree.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useSaveShield } from './mutations';
import { useShieldDoc } from './queries';
import { describeClamps } from '../model/clamps';
import { buildPayload, deepEqual, dirtyStages, normaliseDoc } from '../model/fields';
import type { ShieldDoc, ShieldFields, ShieldSaveResult } from '../model/types';

export interface SaveNotice {
    text: string;
    tabs: string[];
}

interface Draft {
    base: Record<string, unknown>;
    fields: ShieldFields;
}

const draftOf = (doc: ShieldDoc): Draft => ({ base: doc.raw, fields: normaliseDoc(doc.raw) });

function noticeFor(result: ShieldSaveResult, t: ReturnType<typeof useTranslation>): SaveNotice | null {
    if (result.clampedFields.length > 0) return describeClamps(result.clampedFields, t);
    if (result.termErrors.length > 0) {
        return {
            text: t('admin.shield_terms_rejected', 'Saved, with notes. {n} of your own words or patterns were refused and are NOT in force — the offending rows are marked below.', { n: result.termErrors.length }),
            tabs: ['detection'],
        };
    }
    return null;
}

export function useShieldEditor(orgId: string | null) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const doc = useShieldDoc(orgId);
    const save = useSaveShield(orgId);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [syncedFrom, setSyncedFrom] = useState<ShieldDoc | null>(null);
    const [resync, setResync] = useState(false);
    const [notice, setNotice] = useState<SaveNotice | null>(null);
    const [termErrors, setTermErrors] = useState<ShieldSaveResult['termErrors']>([]);

    const snapshot = draft ? buildPayload(draft.base, normaliseDoc(draft.base)) : null;
    const payload = draft ? buildPayload(draft.base, draft.fields) : null;
    const dirty = Boolean(payload && snapshot && !deepEqual(payload, snapshot));

    // Follow the server while nothing is pending; after a save, always.
    const data = doc.data ?? null;
    if (data && data !== syncedFrom && (!dirty || resync)) {
        setSyncedFrom(data);
        setDraft(draftOf(data));
        setResync(false);
    }

    const set = (changes: Partial<ShieldFields>) =>
        setDraft((prev) => (prev ? { ...prev, fields: { ...prev.fields, ...changes } } : prev));

    const discard = () => {
        if (draft) setDraft({ ...draft, fields: normaliseDoc(draft.base) });
        setNotice(null);
    };

    // Switching the shield off unprotects every chat at once: ask first.
    const switchingOff = Boolean(draft && normaliseDoc(draft.base).enabled && !draft.fields.enabled);
    const confirmOff = () =>
        confirm({
            title: t('mobile.orgShield.off_confirm_title', 'Turn protection off for everyone?'),
            message: t('admin.shield_enable_desc_strong', 'Applies to every chat and every agent in this organisation. Off means nothing is checked, at all.'),
            confirmLabel: t('mobile.orgShield.off_confirm_label', 'Turn off and save'),
        });

    const submit = async () => {
        if (!payload) return;
        if (switchingOff && !(await confirmOff())) return;
        setNotice(null);
        save.mutate(payload, {
            onSuccess: (result) => {
                setResync(true);
                setTermErrors(result.termErrors);
                const next = noticeFor(result, t);
                setNotice(next);
                if (next) toast(t('admin.guard_saved_with_notes', 'Saved, with notes — see the message below.'), 'neutral');
                else toast(t('admin.guard_saved', 'Saved successfully!'), 'success');
            },
            onError: (err) => toast(describeError(err).message, 'error'),
        });
    };

    return {
        doc,
        fields: draft?.fields ?? null,
        set,
        dirty,
        dirtyStages: dirty ? dirtyStages(payload, snapshot) : [],
        discard,
        save: () => void submit(),
        saving: save.isPending,
        notice,
        termErrors,
    };
}

export type ShieldEditor = ReturnType<typeof useShieldEditor>;
