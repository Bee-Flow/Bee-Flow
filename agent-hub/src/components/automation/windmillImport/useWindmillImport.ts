import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { importRemoteWindmill, uploadWindmill } from '@/api/windmillImport';
import type { ImportMode, WindmillImportAnswer } from '@/api/windmillImport';

export type ImportSource = 'upload' | 'remote';

export interface RemoteFields {
    baseUrl: string;
    workspace: string;
    token: string;
}

const EMPTY_REMOTE: RemoteFields = { baseUrl: '', workspace: '', token: '' };

/**
 * The Windmill import dialog's state: which source, the file or the remote
 * fields, the preview, which flows are selected, and the commit's results.
 *
 * Stateless towards the server: preview and commit send the same input, so
 * the file (or the remote fields, token included) stays in this state until
 * the dialog closes, and is dropped with it. The token is never written
 * anywhere else.
 */
export default function useWindmillImport({ onCommitted }: { onCommitted?: () => void } = {}) {
    const [source, setSource] = useState<ImportSource>('upload');
    const [file, setFile] = useState<File | null>(null);
    const [remote, setRemote] = useState<RemoteFields>(EMPTY_REMOTE);
    const [preview, setPreview] = useState<WindmillImportAnswer | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [results, setResults] = useState<WindmillImportAnswer['results'] | null>(null);
    // The side-by-side comparison (source W, when the server offers it): off until ticked.
    const [compare, setCompare] = useState(false);
    const [saveAsTests, setSaveAsTests] = useState(false);

    const send = (mode: ImportMode, select?: string[]) => {
        if (source === 'upload') {
            if (!file) throw new Error('no file');
            return uploadWindmill(file, mode, select);
        }
        const withCompare = mode === 'commit' && compare && !!preview?.compare?.runs;
        return importRemoteWindmill({
            source: 'windmill_api', baseUrl: remote.baseUrl.trim(), workspace: remote.workspace.trim(), token: remote.token, mode,
            ...(select ? { select } : {}),
            ...(withCompare ? { compare: { saveAsTests } } : {}),
        });
    };

    const previewMutation = useMutation({
        mutationFn: () => send('preview'),
        onSuccess: (answer) => {
            setPreview(answer);
            setResults(null);
            setSelected(new Set(answer.flows.filter((f) => f.importable).map((f) => f.path)));
        },
    });

    const commitMutation = useMutation({
        mutationFn: () => send('commit', [...selected]),
        onSuccess: (answer) => {
            setResults(answer.results ?? []);
            onCommitted?.();
            // The token has done its work: it is not kept for anything after the import.
            setRemote((r) => ({ ...r, token: '' }));
        },
    });

    const toggle = (path: string) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    const reset = () => {
        setFile(null);
        setRemote(EMPTY_REMOTE);
        setPreview(null);
        setSelected(new Set());
        setResults(null);
        setCompare(false);
        setSaveAsTests(false);
        previewMutation.reset();
        commitMutation.reset();
    };

    const canPreview = source === 'upload' ? !!file : !!(remote.baseUrl.trim() && remote.workspace.trim() && remote.token);

    return {
        source, setSource: (s: ImportSource) => { setSource(s); setPreview(null); setResults(null); },
        file, setFile: (f: File | null) => { setFile(f); setPreview(null); setResults(null); },
        remote, setRemote,
        preview, selected, toggle, results,
        compare, setCompare: (on: boolean) => { setCompare(on); if (!on) setSaveAsTests(false); },
        saveAsTests, setSaveAsTests,
        canPreview,
        runPreview: () => previewMutation.mutate(),
        runCommit: () => commitMutation.mutate(),
        previewing: previewMutation.isPending,
        committing: commitMutation.isPending,
        error: (previewMutation.error ?? commitMutation.error) as Error | null,
        reset,
    };
}

export type WindmillImportState = ReturnType<typeof useWindmillImport>;
