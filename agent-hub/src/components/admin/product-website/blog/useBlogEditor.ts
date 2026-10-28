// State + persistence of the Blog editor in the product-website panel.
//
// Deliberately its own small pipeline instead of riding the page autosave:
// posts are separate documents (cms_project_{site}_post_{id}) with their own
// REST routes, so a post edit can never be clobbered by — or clobber — a
// SiteDoc/PageDoc save. Same behaviour as the page editor though: edits are
// debounced (~700 ms) into one PUT, and `flush()` lets Publish wait for them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthFetchOptions } from '@/utils/helpers';
import { settled } from '@/api/settled';
import {
    blogApi, EDITABLE_POST_FIELDS, postSummary,
    type AdminPost, type AdminPostSummary, type PostTranslation,
} from './blogApi';

const SAVE_DELAY_MS = 700;

export type BlogSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Options {
    siteId: string | null;
    /** Load only once the Blog view is opened. */
    enabled: boolean;
    /** Called after any successful write (the panel marks the site dirty-since-publish). */
    onSaved?: () => void;
}

async function readJson<T>(url: string, init?: AuthFetchOptions): Promise<T> {
    const res = await settled(url, init, 'empty');
    const data = res.ok ? await res.res.json().catch(() => ({})) : res.body;
    if (!res.ok) {
        const msg = (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string')
            ? (data as { error: string }).error
            : `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return data as T;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every piece of state and every ref the editor's hooks share. */
function useBlogState(siteId: string | null, onSaved?: () => void) {
    const [posts, setPosts] = useState<AdminPostSummary[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activePostId, setActivePostId] = useState<string | null>(null);
    const [post, setPostState] = useState<AdminPost | null>(null);
    const [translations, setTranslationsState] = useState<Record<string, PostTranslation>>({});
    const [saveStatus, setSaveStatus] = useState<BlogSaveStatus>('idle');
    const postRef = useRef<AdminPost | null>(null);
    const translationsRef = useRef<Record<string, PostTranslation>>({});
    const dirtyPost = useRef(false);
    const dirtyLocales = useRef<Set<string>>(new Set());
    const editVersion = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inFlight = useRef<Promise<void> | null>(null);
    const site = useRef(siteId);
    const onSavedRef = useRef(onSaved);
    useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
    // The ref is the truth (timers read it); the state renders it.
    const setPost = useCallback((p: AdminPost | null) => { postRef.current = p; setPostState(p); }, []);
    const setTranslations = useCallback((tr: Record<string, PostTranslation>) => {
        translationsRef.current = tr;
        setTranslationsState(tr);
    }, []);
    // One stable bag of refs for the hooks below (the refs never change, so neither does the bag).
    const refs = useMemo(() => ({
        postRef, translationsRef, dirtyPostRef: dirtyPost, dirtyLocalesRef: dirtyLocales, editVersionRef: editVersion,
        timerRef: timer, inFlightRef: inFlight, siteRef: site, onSavedRef,
    }), []);
    return {
        posts, setPosts, loaded, setLoaded, error, setError, activePostId, setActivePostId,
        post, setPost, translations, setTranslations, saveStatus, setSaveStatus, refs,
    };
}

type BlogState = ReturnType<typeof useBlogState>;

/** PUT the post (when dirty) and every dirty translation. */
interface Batch { site: string; current: AdminPost; sendPost: boolean; locales: string[]; versionAtSend: number }

async function sendChanges(st: BlogState, { site, current, sendPost, locales, versionAtSend }: Batch) {
    const { refs } = st;
    if (sendPost) {
        const body: Record<string, unknown> = {};
        for (const k of EDITABLE_POST_FIELDS) body[k] = current[k];
        const { post: saved } = await readJson<{ post: AdminPost }>(blogApi.post(site, current.id), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        // The server owns slug uniqueness and the date of a freshly published
        // post: take its copy back — but only when nothing was typed meanwhile,
        // or it would overwrite the keystrokes in flight.
        const latest = refs.postRef.current;
        if (latest && latest.id === saved.id) {
            st.setPost(refs.editVersionRef.current === versionAtSend
                ? saved
                : { ...latest, publishedAt: latest.publishedAt ?? saved.publishedAt, updatedAt: saved.updatedAt });
        }
        st.setPosts(list => list.map(p => (p.id === saved.id ? postSummary(saved, p.translatedLocales) : p)));
    }
    for (const locale of locales) {
        await readJson(blogApi.postLocale(site, current.id, locale), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ override: refs.translationsRef.current[locale] || {} }),
        });
        st.setPosts(list => list.map(p => (p.id === current.id && !p.translatedLocales.includes(locale)
            ? { ...p, translatedLocales: [...p.translatedLocales, locale] } : p)));
    }
}

function useBlogSaver(st: BlogState) {
    const { refs, setSaveStatus, setError } = st;
    const { timerRef, inFlightRef, siteRef, postRef, dirtyPostRef, dirtyLocalesRef, editVersionRef, onSavedRef } = refs;
    const stRef = useRef(st);
    useEffect(() => { stRef.current = st; });
    const saveNow = useCallback(async (): Promise<void> => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (inFlightRef.current) await inFlightRef.current;
        const site = siteRef.current;
        const current = postRef.current;
        if (!site || !current || (!dirtyPostRef.current && dirtyLocalesRef.current.size === 0)) return;
        const sendPost = dirtyPostRef.current;
        const locales = [...dirtyLocalesRef.current];
        dirtyPostRef.current = false;
        dirtyLocalesRef.current = new Set();
        setSaveStatus('saving');
        const run = sendChanges(stRef.current, { site, current, sendPost, locales, versionAtSend: editVersionRef.current })
            .then(() => { setSaveStatus('saved'); setError(null); onSavedRef.current?.(); })
            .catch((e: unknown) => {
                // Put the work back so the next edit sends it again.
                if (sendPost) dirtyPostRef.current = true;
                for (const l of locales) dirtyLocalesRef.current.add(l);
                setSaveStatus('error');
                setError(message(e));
            });
        inFlightRef.current = run;
        await run;
        inFlightRef.current = null;
    }, [timerRef, inFlightRef, siteRef, postRef, dirtyPostRef, dirtyLocalesRef, setSaveStatus, editVersionRef, setError, onSavedRef]);
    const schedule = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { void saveNow(); }, SAVE_DELAY_MS);
    }, [saveNow, timerRef]);
    return { saveNow, schedule };
}

function useBlogEdits(st: BlogState, schedule: () => void) {
    const { refs, setPost, setPosts, setTranslations } = st;
    const { postRef, editVersionRef, dirtyPostRef, translationsRef, dirtyLocalesRef } = refs;
    const updatePost = useCallback((patch: Partial<AdminPost>) => {
        const current = postRef.current;
        if (!current) return;
        const next = { ...current, ...patch, seo: { ...current.seo, ...(patch.seo || {}) } };
        editVersionRef.current += 1;
        dirtyPostRef.current = true;
        setPost(next);
        setPosts(list => list.map(p => (p.id === next.id ? postSummary(next, p.translatedLocales) : p)));
        schedule();
    }, [dirtyPostRef, editVersionRef, postRef, schedule, setPost, setPosts]);
    const updateTranslation = useCallback((locale: string, patch: PostTranslation) => {
        const prev = translationsRef.current[locale] || {};
        const merged: PostTranslation = { ...prev, ...patch, ...(patch.seo ? { seo: { ...(prev.seo || {}), ...patch.seo } } : {}) };
        setTranslations({ ...translationsRef.current, [locale]: merged });
        dirtyLocalesRef.current.add(locale);
        schedule();
    }, [dirtyLocalesRef, schedule, setTranslations, translationsRef]);
    return { updatePost, updateTranslation };
}

function useBlogDocuments(st: BlogState, saveNow: () => Promise<void>) {
    const { refs, setPost, setPosts, setTranslations, setActivePostId, setError } = st;
    const { siteRef, onSavedRef, postRef, dirtyPostRef, dirtyLocalesRef } = refs;
    const selectPost = useCallback(async (postId: string | null) => {
        await saveNow();
        setActivePostId(postId);
        if (!postId) { setPost(null); setTranslations({}); return; }
        const site = siteRef.current;
        if (!site) return;
        try {
            const data = await readJson<{ post: AdminPost; translations: Record<string, PostTranslation> }>(blogApi.post(site, postId));
            setTranslations(data.translations || {});
            setPost(data.post);
            setError(null);
        } catch (e) { setError(message(e)); }
    }, [saveNow, setActivePostId, siteRef, setPost, setTranslations, setError]);

    const createPost = useCallback(async (title: string): Promise<AdminPost | null> => {
        const site = siteRef.current;
        if (!site) return null;
        await saveNow();
        try {
            const { post: created } = await readJson<{ post: AdminPost }>(blogApi.posts(site), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
            });
            setPosts(list => [postSummary(created), ...list]);
            setTranslations({});
            setPost(created);
            setActivePostId(created.id);
            onSavedRef.current?.();
            return created;
        } catch (e) { setError(message(e)); return null; }
    }, [siteRef, saveNow, setPosts, setTranslations, setPost, setActivePostId, onSavedRef, setError]);

    const deletePost = useCallback(async (postId: string): Promise<boolean> => {
        const site = siteRef.current;
        if (!site) return false;
        const isOpen = postRef.current?.id === postId;
        if (isOpen) { dirtyPostRef.current = false; dirtyLocalesRef.current = new Set(); }
        try {
            await readJson(blogApi.post(site, postId), { method: 'DELETE' });
            setPosts(list => list.filter(p => p.id !== postId));
            if (isOpen) { setPost(null); setActivePostId(null); }
            onSavedRef.current?.();
            return true;
        } catch (e) { setError(message(e)); return false; }
    }, [siteRef, postRef, dirtyPostRef, dirtyLocalesRef, setPosts, onSavedRef, setPost, setActivePostId, setError]);
    return { selectPost, createPost, deletePost };
}

/** The post list: loaded when the Blog view first opens, reset on a site switch. */
function useBlogList(st: BlogState, siteId: string | null, enabled: boolean, saveNow: () => Promise<void>) {
    const { refs, setPosts, setLoaded, setError, setPost, setActivePostId, loaded } = st;
    const { siteRef } = refs;
    useEffect(() => {
        if (siteRef.current === siteId) return;
        const previous = siteRef.current;
        void (async () => {
            if (previous) await saveNow();   // flush to the OLD site first
            siteRef.current = siteId;
            setPost(null);
            setActivePostId(null);
            setPosts([]);
            setLoaded(false);
        })();
    }, [siteId, saveNow, setPost, setActivePostId, setPosts, setLoaded, siteRef]);

    const reload = useCallback(async () => {
        const site = siteRef.current;
        if (!site) return;
        try {
            const data = await readJson<{ posts: AdminPostSummary[] }>(blogApi.posts(site));
            if (siteRef.current !== site) return;
            setPosts(Array.isArray(data.posts) ? data.posts : []);
            setError(null);
        } catch (e) {
            setError(message(e));
        } finally {
            setLoaded(true);
        }
    }, [siteRef, setPosts, setError, setLoaded]);

    useEffect(() => {
        if (enabled && siteId && !loaded) void reload();
    }, [enabled, siteId, loaded, reload]);
    return reload;
}

export default function useBlogEditor({ siteId, enabled, onSaved }: Options) {
    const st = useBlogState(siteId, onSaved);
    const { saveNow, schedule } = useBlogSaver(st);
    const edits = useBlogEdits(st, schedule);
    const docs = useBlogDocuments(st, saveNow);
    const reload = useBlogList(st, siteId, enabled, saveNow);
    const saveRef = useRef(saveNow);
    useEffect(() => { saveRef.current = saveNow; }, [saveNow]);
    // Unmount: send whatever is pending.
    useEffect(() => () => { void saveRef.current(); }, []);
    const flush = useCallback(() => saveNow(), [saveNow]);
    return {
        posts: st.posts, loaded: st.loaded, error: st.error, setError: st.setError,
        activePostId: st.activePostId, post: st.post, translations: st.translations, saveStatus: st.saveStatus,
        ...docs, ...edits, flush, reload,
    };
}

export type BlogEditor = ReturnType<typeof useBlogEditor>;
