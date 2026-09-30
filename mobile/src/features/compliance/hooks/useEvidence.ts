/**
 * Pick one evidence file and upload it (POST /iso/evidence/upload). The
 * server's 15 MB limit is checked first so a refusal costs no upload; the
 * resolved ref is what an attestation carries.
 */

import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';

import { useTranslation } from '@/core/i18n';

import { EVIDENCE_MAX_BYTES, uploadEvidence, type EvidenceMeta, type EvidenceRef } from '../api/upload';

export type EvidenceResult = { ref: EvidenceRef } | { error: string } | null;

export function useEvidenceUpload(meta: EvidenceMeta) {
    const t = useTranslation();
    const [uploading, setUploading] = useState(false);

    const pickAndUpload = async (): Promise<EvidenceResult> => {
        const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
        const asset = picked.canceled ? undefined : picked.assets[0];
        if (!asset) return null;
        if (asset.size && asset.size > EVIDENCE_MAX_BYTES) {
            return { error: t('mobile.compliance.evidence_too_large', 'An evidence file is at most 15 MB.') };
        }
        setUploading(true);
        try {
            const file = { uri: asset.uri, name: asset.name || 'evidence', mimeType: asset.mimeType || 'application/octet-stream' };
            return { ref: await uploadEvidence(file, meta) };
        } catch {
            return { error: t('compliance.custom_err_upload', 'The file could not be stored as evidence.') };
        } finally {
            setUploading(false);
        }
    };

    return { uploading, pickAndUpload };
}
