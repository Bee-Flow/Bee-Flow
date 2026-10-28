/**
 * The two pickers that attach a file the user does NOT have on this machine:
 * Google Drive and Gmail.
 *
 * They are modals rather than flyouts because both browse a remote account,
 * and they sit outside the composer's drop zone on purpose — a Drive document
 * arrives already fetched, as text, so nothing about it goes through the
 * resize/data-URL path a local file does.
 *
 * Each records WHERE the file came from (`source`), which is the one thing the
 * composer cannot re-derive later from a name and a mime type.
 */
import React from 'react';

import { API_BASE } from '@/utils/helpers';
import GmailPicker from '../GmailPicker';
import GoogleDrivePicker from '../GoogleDrivePicker';
import type { Attachment } from './attachmentFiles';
import type { ExportedAttachment } from '@/hooks/useGoogleWorkspacePicker';

type PickedFile = {
    name: string;
    type?: string;
    size?: number;
    content?: string;
};

interface ExternalFilePickersProps {
    driveOpen: boolean;
    onDriveClose: () => void;
    gmailOpen: boolean;
    onGmailClose: () => void;
    onAdd: (attachments: (Omit<Attachment, 'content'> & { content?: string; source: string })[]) => void;
}

const ExternalFilePickers = ({ driveOpen, onDriveClose, gmailOpen, onGmailClose, onAdd }: ExternalFilePickersProps) => (
    <>
        {/* Google Drive Picker Modal */}
        <GoogleDrivePicker
            isOpen={driveOpen}
            onClose={onDriveClose}
            apiBase={API_BASE}
            onFilesSelected={(driveFiles: PickedFile[]) => {
                const newAttachments = driveFiles.map((f: PickedFile) => ({
                    name: f.name,
                    type: f.type || 'text/plain',
                    size: f.size || f.content?.length || 0,
                    content: f.content,
                    source: 'google-drive',
                }));
                onAdd(newAttachments);
            }}
        />

        {/* Gmail Picker Modal */}
        <GmailPicker
            isOpen={gmailOpen}
            onClose={onGmailClose}
            apiBase={API_BASE}
            onFilesSelected={(emailFiles: ExportedAttachment[]) => {
                const newAttachments = (emailFiles as PickedFile[]).map((f: PickedFile) => ({
                    name: f.name,
                    type: f.type || 'text/plain',
                    size: f.size || f.content?.length || 0,
                    content: f.content,
                    source: 'gmail',
                }));
                onAdd(newAttachments);
            }}
        />
    </>
);

export default ExternalFilePickers;
