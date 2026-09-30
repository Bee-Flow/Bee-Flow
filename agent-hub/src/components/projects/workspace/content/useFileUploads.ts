// Upload a batch of files into the project, one after the other, keeping a
// row per file that is still on its way or was refused. A file that went in
// disappears from this list: from then on it is in the project's file list.

import { useRef, useState } from 'react';
import { MAX_PROJECT_FILE_BYTES, useUploadProjectFile } from '../../../../api/queries/projectContent';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';

export interface UploadRow {
    key: string;
    name: string;
    status: 'uploading' | 'failed';
    error?: string;
}

export default function useFileUploads(projectId: string) {
    const { t } = useTranslation();
    const upload = useUploadProjectFile(projectId);
    const [rows, setRows] = useState<UploadRow[]>([]);
    const seq = useRef(0);

    const patch = (key: string, next: Partial<UploadRow> | null) => {
        setRows(prev => (next === null ? prev.filter(r => r.key !== key) : prev.map(r => (r.key === key ? { ...r, ...next } : r))));
    };

    const uploadOne = async (file: File, key: string) => {
        if (file.size > MAX_PROJECT_FILE_BYTES) {
            patch(key, { status: 'failed', error: t('project_content.file_too_large', 'Larger than the 20 MB limit.') });
            return;
        }
        try {
            await upload.mutateAsync(file);
            patch(key, null);
        } catch (e) {
            // A 413 can come from a proxy in front of the server, without a body.
            const tooLarge = (e as { status?: number | null })?.status === 413 && !(e as { serverMessage?: string | null }).serverMessage;
            patch(key, {
                status: 'failed',
                error: tooLarge
                    ? t('project_content.file_too_large', 'Larger than the 20 MB limit.')
                    : projectErrorText(t, e, t('project_content.file_upload_failed', 'Could not upload this file.')),
            });
        }
    };

    const add = async (files: File[]) => {
        const batch = files.map(file => ({ file, key: `u${++seq.current}` }));
        if (!batch.length) return;
        setRows(prev => [...prev, ...batch.map(({ file, key }) => ({ key, name: file.name, status: 'uploading' as const }))]);
        // One at a time: the server extracts and scans each file, and a burst
        // of parallel uploads would only queue there instead.
        for (const { file, key } of batch) await uploadOne(file, key);
    };

    const dismiss = (key: string) => patch(key, null);

    return { rows, add, dismiss, busy: rows.some(r => r.status === 'uploading') };
}
