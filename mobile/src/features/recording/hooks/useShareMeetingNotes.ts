/**
 * Share a meeting's notes as a Markdown FILE, not a message: a full transcript
 * pasted into a share sheet is truncated by half the apps that receive it.
 * With no share target at all, the notes go to the clipboard instead.
 */

import * as Clipboard from 'expo-clipboard';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { describeError } from '@/core/api/errors';
import { useToast } from '@/shared/ui';

import { exportTranscription } from '../api/endpoints';
import type { Transcription } from '../model/types';

function writeExport(title: string, markdown: string): File {
    const safeName = (title || 'Meeting').replace(/[^\p{L}\p{N} _-]/gu, '').trim();
    const dir = new Directory(Paths.cache, 'exports');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${safeName || 'Meeting'}.md`);
    if (file.exists) file.delete();
    file.create();
    file.write(markdown);
    return file;
}

export function useShareMeetingNotes() {
    const { toast } = useToast();
    return async (meeting: Transcription) => {
        try {
            const markdown = await exportTranscription(meeting.id, 'md');
            if (!markdown) {
                toast('Nothing to export yet', 'error');
                return;
            }
            const file = writeExport(meeting.title, markdown);
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(file.uri, {
                    mimeType: 'text/markdown',
                    dialogTitle: meeting.title,
                    UTI: 'net.daringfireball.markdown',
                });
            } else {
                await Clipboard.setStringAsync(markdown);
                toast('Copied the notes to the clipboard', 'success');
            }
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };
}
