/**
 * A conversation as Markdown, for the share sheet and for a file export.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { translate } from '@/core/i18n';

import type { ChatMessage } from './types';

const untitled = () => translate('mobile.chat.details.share_title', 'Bee Flow conversation');

/**
 * The transcript, as Markdown.
 *
 * Tool and system turns are dropped: they are internal machinery and a person
 * sharing a conversation means the conversation. `thinking` is dropped for the
 * same reason — it is the model's scratchpad, not the answer, and it is not
 * what someone intends to forward to a colleague.
 */
export function transcriptMarkdown(title: string | null | undefined, messages: ChatMessage[]): string {
    const header = `# ${title || untitled()}\n\n`;
    const body = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => {
            const who = message.role === 'user' ? translate('mobile.chat.transcript_you', 'You') : 'Bee Flow';
            const when = message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString()}` : '';
            const names = message.attachments?.map((a) => a.name).join(', ');
            const attachments = names ? `\n\n_${translate('mobile.chat.transcript_attachments', 'Attachments: {names}', { names })}_` : '';
            return `## ${who}${when}\n\n${message.content}${attachments}`;
        })
        .join('\n\n');
    return `${header}${body}\n`;
}

/** Strip anything Android's file layer would object to. */
export function safeFileName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    return (cleaned.length ? cleaned.slice(0, 80) : 'conversation') + '.md';
}

/**
 * Write the transcript to the cache and hand it to the share sheet.
 *
 * Deliberately a real file rather than a clipboard blob, so it can land in
 * Drive, an email or a Files app like anything else. The cache directory is
 * reclaimed by the OS when it needs the space, so nothing accumulates.
 */
export async function exportTranscript(title: string | null | undefined, messages: ChatMessage[]): Promise<void> {
    const name = safeFileName(title || untitled());
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create({ overwrite: true, intermediates: true });
    file.write(transcriptMarkdown(title, messages));

    if (!(await Sharing.isAvailableAsync())) {
        throw new Error(translate('mobile.chat.share_unavailable', 'This phone has nothing that can receive a shared file.'));
    }
    await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: name });
}
