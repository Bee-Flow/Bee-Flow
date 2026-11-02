import { useEffect, useMemo, useState } from 'react';
import { logger } from '@/utils/logger';
import { normalizeContentId } from '@/components/support/EmailHtmlBody';
import { walkPath } from '../resolveBinding';
import { fetchFileBlob, firstDescriptor, type FileEntry } from './fileLoading';

/** Content ids a mail body points at with `src="cid:…"`, normalised. */
function referencedContentIds(html: unknown): Set<string> {
    const ids = new Set<string>();
    if (typeof html !== 'string') return ids;
    for (const m of html.matchAll(/\bsrc\s*=\s*["']\s*cid:([^"']*)["']/gi)) ids.add(normalizeContentId(m[1]));
    return ids;
}

interface InlineImageJob { cid: string; entry: FileEntry }

interface Args {
    html: unknown;
    attachments: unknown;
    fileKey: string | null | undefined;
    contentIdKey: string | null | undefined;
    appId: string | null | undefined;
    live: boolean;
}

/**
 * The inline pictures of ONE message: content id → object URL, loaded lazily and
 * only for ids that message's HTML actually references. A pending mailbox
 * attachment is redeemed first (with inline: true, image/* only on the server).
 * `referenced` lists the attachment rows whose picture sits inside the mail, so
 * the caller can leave them out of the chip list.
 */
export function useInlineImages({ html, attachments, fileKey, contentIdKey, appId, live }: Args) {
    const enabled = !!(fileKey && contentIdKey);
    const { jobs, inlineRows } = useMemo(() => {
        const out = { jobs: [] as InlineImageJob[], inlineRows: new Set<unknown>() };
        if (!enabled || !Array.isArray(attachments)) return out;
        const wanted = referencedContentIds(html);
        if (wanted.size === 0) return out;
        for (const row of attachments) {
            if (!row || typeof row !== 'object') continue;
            const raw = walkPath(row, contentIdKey as string);
            if (raw == null || raw === '') continue;
            const cid = normalizeContentId(String(raw));
            if (!wanted.has(cid)) continue;
            out.inlineRows.add(row);
            const entry = firstDescriptor(walkPath(row, fileKey as string));
            if (entry && !out.jobs.some((j) => j.cid === cid)) out.jobs.push({ cid, entry });
        }
        return out;
    }, [enabled, html, attachments, fileKey, contentIdKey]);

    // The effect restarts only when the set of files changes, not on every poll.
    const jobsKey = JSON.stringify(jobs);
    const [urls, setUrls] = useState<Record<string, string>>({});

    useEffect(() => {
        const todo = JSON.parse(jobsKey) as InlineImageJob[];
        if (!live || !appId || todo.length === 0) return undefined;
        let cancelled = false;
        const created: string[] = [];
        (async () => {
            for (const job of todo) {
                try {
                    const { blob, mime } = await fetchFileBlob(job.entry, appId, { inline: true });
                    // Pictures only: the server enforces it too, this keeps a stray type out of <img>.
                    if (!/^image\//i.test(mime)) continue;
                    const url = URL.createObjectURL(blob.type === mime ? blob : new Blob([blob], { type: mime }));
                    if (cancelled) { URL.revokeObjectURL(url); return; }
                    created.push(url);
                    setUrls((prev) => ({ ...prev, [job.cid]: url }));
                } catch (err) { logger.debug('inline image failed; the mail still reads', err); }
            }
        })();
        return () => {
            cancelled = true;
            created.forEach((u) => URL.revokeObjectURL(u));
        };
    }, [jobsKey, appId, live]);

    const inlineImages = useMemo(() => {
        const cids = (JSON.parse(jobsKey) as InlineImageJob[]).map((j) => j.cid).filter((cid) => urls[cid]);
        return cids.length > 0 ? Object.fromEntries(cids.map((cid) => [cid, urls[cid]])) : undefined;
    }, [jobsKey, urls]);

    return { inlineImages, inlineRows };
}
