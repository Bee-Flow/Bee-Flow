/**
 * The library's template files (.bftemplate): download a template or reusable
 * section as one, and import one as a new private template, which then opens.
 * What went wrong, or a picture that could not come along, is said in plain
 * words through `onMessage`.
 */
import { useRef, useState } from 'react';

import { exportTemplateFile, importTemplateFile, TemplateFileError } from '@/api/templateFileApi';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import type { LibraryRow } from '../documentQueries';

interface Options {
    folderId?: string;
    onImported: (id: string) => void;
    onMessage: (text: string) => void;
}

export default function useTemplateFile({ folderId, onImported, onMessage }: Options) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);

    const exportRow = async (row: LibraryRow) => {
        try {
            const { skippedImages } = await exportTemplateFile(row.id, row.name);
            if (skippedImages > 0) {
                onMessage(t('doc_template_file.skipped_images', 'Downloaded. {count} picture(s) could not be put in the file; add them again after importing.', { count: skippedImages }));
            }
        } catch (e) {
            onMessage(messageOf(e, t('doc_template_file.export_failed', 'The template file could not be made. Please try again.')));
        }
    };

    const importFile = async (file: File | undefined) => {
        if (!file) return;
        setImporting(true);
        try {
            const made = await importTemplateFile(file, folderId);
            if (made.id) onImported(made.id);
        } catch (e) {
            onMessage(e instanceof TemplateFileError
                ? t('doc_template_file.not_a_file', 'This is not a Bee Flow template file (.bftemplate).')
                : messageOf(e, t('doc_template_file.import_failed', 'The template could not be imported. Please try again.')));
        } finally {
            setImporting(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    };

    return { inputRef, importing, exportRow, importFile, pick: () => inputRef.current?.click() };
}
