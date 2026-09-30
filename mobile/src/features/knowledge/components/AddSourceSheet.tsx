/**
 * "Add a source" — the four doors a notebook or a knowledge base accepts.
 *
 * File, photo, scan and link are separate rows rather than one "Add" button
 * with a menu, because on a phone they are genuinely different decisions and
 * the scan option is the one people do not know exists. Paste-text is last
 * and quiet: it is the only one of the four that is faster on a desktop.
 *
 * The sheet only collects the intent. Every mutation is the caller's, because
 * the notebook and knowledge-base endpoints differ (…/sources/url vs
 * …/ingest/url) and hiding that behind a prop would be a lie about one of them.
 */

import React, { useState } from 'react';

import { AddSourceMenu } from './AddSourceMenu';
import { AddTextForm, type TextDraft } from './AddTextForm';
import { AddUrlForm, type UrlDraft } from './AddUrlForm';
import type { UploadFile } from '../api/upload';

export interface AddSourceSheetProps {
    onFiles: (files: UploadFile[]) => void;
    /** Opens the camera. The parent owns <ScanCamera> so it survives this sheet closing. */
    onScan: () => void;
    onUrl: (url: string) => void;
    /** Omit to hide the paste-text door — not every target accepts one. */
    onText?: (text: string, name: string) => void;
    /** Hint under the file row, e.g. "PDF, Word, Excel, CSV or text · up to 20 MB". */
    accepts?: string;
    busy?: boolean;
}

export function AddSourceBody({ onFiles, onScan, onUrl, onText, accepts, busy = false }: AddSourceSheetProps) {
    const [mode, setMode] = useState<'menu' | 'url' | 'text'>('menu');
    const [urlDraft, setUrlDraft] = useState<UrlDraft>({ url: '', error: null });
    const [textDraft, setTextDraft] = useState<TextDraft>({ text: '', name: '' });
    const back = () => setMode('menu');

    if (mode === 'url') {
        return <AddUrlForm draft={urlDraft} onChange={setUrlDraft} busy={busy} onUrl={onUrl} onBack={back} />;
    }
    if (mode === 'text' && onText) {
        return <AddTextForm draft={textDraft} onChange={setTextDraft} busy={busy} onText={onText} onBack={back} />;
    }
    return (
        <AddSourceMenu
            accepts={accepts}
            onFiles={onFiles}
            onScan={onScan}
            onUrl={() => setMode('url')}
            onText={onText ? () => setMode('text') : undefined}
        />
    );
}
