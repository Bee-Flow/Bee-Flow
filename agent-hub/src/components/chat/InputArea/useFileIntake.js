/**
 * Every way a file gets INTO the composer that is not a paste: the hidden file
 * input behind "Add photos & files", and a drag-and-drop onto the box.
 *
 * All of them funnel through one `processFiles`, which is also what
 * usePasteAttachments is handed — three entry points, one place that decides
 * what an attachment is (attachmentFiles.js). The drop zone's own leave
 * handler checks `contains(relatedTarget)` rather than counting enter/leave
 * pairs: dragging across a child element fires a leave for the parent, and a
 * naive handler drops the highlight halfway across its own box.
 *
 * The file input is cleared after every selection, so picking the SAME file
 * twice in a row still fires `change` the second time.
 */
import { useCallback } from 'react';

import { buildAttachments } from './attachmentFiles';

export default function useFileIntake({ setAttachments, setIsDragOver, fileInputRef, dropZoneRef }) {
    // Process files (shared between file input, drop, and paste)
    const processFiles = useCallback(async (files) => {
        if (files.length === 0) return;
        const newAttachments = await buildAttachments(files);

        if (newAttachments.length > 0) {
            setAttachments(prev => [...prev, ...newAttachments]);
        }
    }, [setAttachments]);

    const handleFileSelect = async (e) => {
        const files = Array.from(e.target.files || []);
        await processFiles(files);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // ---- Drag & Drop ----
    const handleDragEnter = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    }, [setIsDragOver]);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only set false if leaving the drop zone entirely
        if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget)) {
            setIsDragOver(false);
        }
    }, [setIsDragOver, dropZoneRef]);

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length > 0) {
            await processFiles(files);
        }
    }, [processFiles, setIsDragOver]);

    return { processFiles, handleFileSelect, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}
