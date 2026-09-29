/**
 * "Add a source" — the four doors a notebook or a knowledge base accepts.
 *
 * File, photo, scan and link are separate rows rather than one "Add" button
 * with a menu, because on a phone they are genuinely different decisions and
 * the scan option is the one people do not know exists.
 *
 * Paste-text is last and quiet: it is the fallback for "I have the words but
 * not the file", and it is the only one of the four that is faster on a
 * desktop, so it does not deserve top billing here.
 *
 * The sheet only collects the intent. Every mutation is the caller's, because
 * the notebook and knowledge-base endpoints differ (…/sources/url vs
 * …/ingest/url) and hiding that behind a prop would be a lie about one of them.
 */

import { Feather } from '@expo/vector-icons';
import React, { useState } from 'react';
import { View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/Input';
import { ListRow } from '../../../ui/List';
import { Divider } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import { pickDocuments, pickImages } from '../pickers';
import type { UploadFile } from '../upload';

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
    const theme = useTheme();
    const [mode, setMode] = useState<'menu' | 'url' | 'text'>('menu');
    const [url, setUrl] = useState('');
    const [text, setText] = useState('');
    const [textName, setTextName] = useState('');
    const [error, setError] = useState<string | null>(null);

    if (mode === 'url') {
        return (
            <View style={{ gap: theme.spacing.lg }}>
                <TextField
                    label="Web address"
                    value={url}
                    onChangeText={(v) => {
                        setUrl(v);
                        setError(null);
                    }}
                    error={error}
                    placeholder="https://example.com/report"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    autoFocus
                    hint="Bee Flow fetches the page on the server and keeps the text, not the page."
                />
                <Button
                    label="Add link"
                    fullWidth
                    loading={busy}
                    onPress={() => {
                        const value = url.trim();
                        // The server screens for SSRF, but an obviously wrong
                        // scheme is worth catching before a round trip.
                        if (!/^https?:\/\/\S+\./i.test(value)) {
                            setError('Enter a full web address, starting with http:// or https://');
                            return;
                        }
                        onUrl(value);
                        setUrl('');
                    }}
                />
                <Button label="Back" variant="ghost" onPress={() => setMode('menu')} />
            </View>
        );
    }

    if (mode === 'text' && onText) {
        return (
            <View style={{ gap: theme.spacing.lg }}>
                <TextField
                    label="Title"
                    value={textName}
                    onChangeText={setTextName}
                    placeholder="Meeting notes"
                />
                <TextField
                    label="Text"
                    value={text}
                    onChangeText={setText}
                    multiline
                    maxLines={10}
                    placeholder="Paste anything you want this to know about."
                />
                <Button
                    label="Add text"
                    fullWidth
                    loading={busy}
                    disabled={text.trim().length < 3}
                    onPress={() => {
                        onText(text.trim(), textName.trim() || 'Pasted text');
                        setText('');
                        setTextName('');
                    }}
                />
                <Button label="Back" variant="ghost" onPress={() => setMode('menu')} />
            </View>
        );
    }

    return (
        <View>
            <ListRow
                title="Choose a file"
                subtitle={accepts}
                leading={<Feather name="file-plus" size={20} color={theme.colors.textMuted} />}
                onPress={() => {
                    void pickDocuments().then((files) => {
                        if (files.length) onFiles(files);
                    });
                }}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title="Scan with the camera"
                subtitle="Photograph a page — several, if it has several"
                leading={<Feather name="camera" size={20} color={theme.colors.textMuted} />}
                onPress={onScan}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title="Pick a photo"
                subtitle="From this device's gallery"
                leading={<Feather name="image" size={20} color={theme.colors.textMuted} />}
                onPress={() => {
                    void pickImages().then((files) => {
                        if (files.length) onFiles(files);
                    });
                }}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title="Add a link"
                subtitle="A web page, fetched and kept as text"
                leading={<Feather name="link" size={20} color={theme.colors.textMuted} />}
                onPress={() => setMode('url')}
            />
            {onText ? (
                <>
                    <Divider inset={theme.spacing.lg} />
                    <ListRow
                        title="Paste text"
                        subtitle="When you have the words but not the file"
                        leading={<Feather name="align-left" size={20} color={theme.colors.textMuted} />}
                        onPress={() => setMode('text')}
                    />
                </>
            ) : null}

            <Text
                variant="label"
                tone="tertiary"
                style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}
            >
                Everything you add is processed on your own server. Text extraction and embedding
                happen in the background, so a large file stays &ldquo;processing&rdquo; for a while.
            </Text>
        </View>
    );
}
