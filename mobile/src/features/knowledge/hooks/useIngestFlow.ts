/**
 * The add-a-source flow a knowledge base and a notebook share: the add sheet,
 * the scanner, the upload queue, and the link and paste-text writes.
 *
 * The endpoints differ (…/ingest/url for a base, …/sources/url for a
 * notebook), so the caller passes them in; everything else is one flow. The
 * sheets themselves are components/IngestSheets.tsx.
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { useToast } from '@/shared/ui';

import { useRefreshKnowledge } from './mutations';
import { useUploadQueue, type UseUploadQueue } from './useUploadQueue';
import { ingestKbText, ingestKbUrl } from '../api/endpoints';
import { kbIngestTarget, type UploadTarget } from '../api/upload';

export interface IngestFlowOptions {
    target: UploadTarget;
    addUrl: (url: string) => Promise<unknown>;
    addText: (text: string, name: string) => Promise<unknown>;
    /** Said once a link is accepted, in the caller's own words. */
    onUrlAdded: () => void;
    /** Whatever a new source makes stale. */
    onChanged: () => void;
}

export interface IngestFlow {
    uploads: UseUploadQueue;
    addOpen: boolean;
    setAddOpen: (open: boolean) => void;
    scanOpen: boolean;
    setScanOpen: (open: boolean) => void;
    addUrl: (url: string) => void;
    addText: (text: string, name: string) => void;
    /** A link or a paste is on its way. */
    busy: boolean;
}

export function useIngestFlow(options: IngestFlowOptions): IngestFlow {
    const { toast } = useToast();
    const [addOpen, setAddOpen] = useState(false);
    const [scanOpen, setScanOpen] = useState(false);
    const uploads = useUploadQueue(options.target, { onUploaded: options.onChanged });

    const url = useMutation({
        mutationFn: (value: string) => options.addUrl(value),
        onSuccess: () => {
            setAddOpen(false);
            options.onUrlAdded();
            options.onChanged();
        },
    });

    const text = useMutation({
        mutationFn: (input: { text: string; name: string }) => options.addText(input.text, input.name),
        onSuccess: () => {
            setAddOpen(false);
            toast('Added', 'success');
            options.onChanged();
        },
    });

    return {
        uploads,
        addOpen,
        setAddOpen,
        scanOpen,
        setScanOpen,
        addUrl: (value) => url.mutate(value),
        addText: (value, name) => text.mutate({ text: value, name }),
        busy: url.isPending || text.isPending,
    };
}

/**
 * The flow into one knowledge base. `kbId` is read when a write is sent, so a
 * screen that picks the destination later (Documents) can pass it as it is.
 */
export function useKbIngestFlow(kbId: string): IngestFlow {
    const { toast } = useToast();
    const refresh = useRefreshKnowledge();
    return useIngestFlow({
        target: kbIngestTarget(kbId),
        addUrl: (url) => ingestKbUrl(kbId, url),
        addText: (text, name) => ingestKbText(kbId, text, name),
        onUrlAdded: () => toast('Page added', 'success'),
        onChanged: refresh,
    });
}
