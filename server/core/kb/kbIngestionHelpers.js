/**
 * KB Ingestion Helpers — shared logic for both Knowledge Base routes
 * and Notebook source ingestion.
 *
 * Extracts common patterns:
 *   • File content extraction (with Azure Doc Intelligence + OCR fallbacks)
 *   • URL fetching → Markdown conversion
 *   • Document ingestion (dedup → search-service chunk+embed)
 *   • Azure embedding param resolution
 *   • Chunk cleanup via search-service
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const configStore = require('../../stores/configStore');
const kbStore = require('../../stores/knowledgeBases');
const { getServiceHeaders } = require('../serviceAuth');
const { friendlyError } = require('./friendlyError');
const log = require('../../telemetry/log');

/**
 * SSRF guard — reject any URL that resolves to a private, loopback,
 * link-local, or otherwise non-routable address. Used by every code path
 * that fetches user-supplied URLs server-side (KB/notebook/webpage source
 * ingestion). Pre-validates the hostname; callers should also re-check the
 * `response.url` post-fetch to catch redirects to internal services.
 *
 * Rejects:
 *   - non-http(s) schemes (file:, gopher:, ftp:, ...)
 *   - hostnames that resolve to 0.0.0.0/8, 10/8, 127/8, 169.254/16,
 *     172.16/12, 192.168/16
 *   - IPv6 loopback (::1), link-local (fe80::/10), unique-local (fc00::/7),
 *     IPv4-mapped versions of the above
 *
 * Throws on rejection; resolves with the validated parsed URL on success.
 */
async function assertUrlIsPublic(url) {
    let parsed;
    try { parsed = new URL(url); }
    catch (_) { throw new Error('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP/HTTPS URLs are allowed');
    }
    const host = parsed.hostname;
    if (!host) throw new Error('URL is missing a hostname');

    // Resolve hostnames to one or more addresses; literal IPs short-circuit.
    let addresses;
    if (net.isIP(host)) {
        addresses = [{ address: host, family: net.isIP(host) }];
    } else {
        try {
            addresses = await dns.lookup(host, { all: true });
        } catch (e) {
            throw new Error(`DNS lookup failed for ${host}: ${e.message}`);
        }
    }
    for (const a of addresses) {
        if (isPrivateAddress(a.address)) {
            throw new Error(`URL ${host} resolves to a private/loopback address (${a.address})`);
        }
    }
    return parsed;
}

function isPrivateAddress(addr) {
    if (!addr) return true;
    // Strip IPv4-mapped IPv6 prefix (::ffff:127.0.0.1 → 127.0.0.1).
    const ipv4Mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4Mapped) addr = ipv4Mapped[1];
    const ipVer = net.isIP(addr);
    if (ipVer === 4) {
        const parts = addr.split('.').map(Number);
        if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
        const [a, b] = parts;
        // 0/8 current network, 10/8, 127/8 loopback
        if (a === 0 || a === 10 || a === 127) return true;
        // 169.254/16 link-local (AWS/Azure metadata endpoint)
        if (a === 169 && b === 254) return true;
        // 172.16/12 private
        if (a === 172 && b >= 16 && b <= 31) return true;
        // 192.168/16 private
        if (a === 192 && b === 168) return true;
        // 100.64/10 carrier-grade NAT
        if (a === 100 && b >= 64 && b <= 127) return true;
        return false;
    }
    if (ipVer === 6) {
        const lc = addr.toLowerCase();
        if (lc === '::1' || lc === '::' ) return true;
        // fe80::/10 link-local
        if (/^fe[89ab][0-9a-f]:/.test(lc)) return true;
        // fc00::/7 unique local
        if (/^f[cd][0-9a-f]{2}:/.test(lc)) return true;
        return false;
    }
    return true; // unknown format → treat as unsafe
}

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

/**
 * SimHash (64-bit) over normalized tokens of `text`.
 * Used for near-duplicate detection — small hamming distance (≤3) means
 * two documents are ~99% the same text modulo whitespace / casing.
 *
 * Returns a signed BigInt fitting Postgres BIGINT, or null for empty input.
 */
function simhash64(text) {
    if (!text) return null;
    const normalized = String(text)
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\d{5,}/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return null;
    const tokens = normalized.split(' ').filter(t => t.length > 2);
    if (tokens.length === 0) return null;

    const v = new Array(64).fill(0);
    for (const tok of tokens) {
        const h = crypto.createHash('md5').update(tok).digest();
        for (let bit = 0; bit < 64; bit++) {
            const byte = h[bit >> 3];
            const isSet = (byte >> (bit & 7)) & 1;
            v[bit] += isSet ? 1 : -1;
        }
    }
    // Convert bit vector to 64-bit two's-complement signed BigInt.
    let unsigned = 0n;
    for (let i = 0; i < 64; i++) if (v[i] > 0) unsigned |= (1n << BigInt(i));
    // Postgres BIGINT is signed; map high bit to negative range.
    const signed = unsigned >= (1n << 63n) ? unsigned - (1n << 64n) : unsigned;
    // Node's Postgres driver accepts BigInt for bigint columns.
    return signed;
}

/**
 * Read Azure embedding credentials from configStore.
 * Returns { use_azure, azure_endpoint?, azure_key?, azure_model? }
 */
async function getAzureIngestParams() {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (!useAzure) return { use_azure: false };
    return {
        use_azure: true,
        azure_endpoint: await configStore.getConfig('azure_openai_embedding_endpoint') || '',
        azure_key: await configStore.getSecret('azure_openai_embedding_key') || '',
        azure_model: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
    };
}

const XLSX_MIMES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
]);

function isSpreadsheetFile(mime, filename) {
    return XLSX_MIMES.has(mime) || /\.(xlsx|xls)$/i.test(filename || '');
}

/**
 * Sheet names of a workbook, cheaply (`bookSheets` reads the directory only,
 * not the cells). Best-effort: null when the buffer is not a workbook.
 */
function readSheetNames(buffer) {
    try {
        const XLSX = require('@e965/xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer', bookSheets: true });
        return Array.isArray(wb?.SheetNames) ? wb.SheetNames.slice() : null;
    } catch (_) {
        return null;
    }
}

/**
 * Extract text from a file buffer, plus what we learn about the file on the way.
 *
 * Supports: PDF (pdfjs-dist + Mistral OCR fallback), DOCX, XLSX, CSV, TXT, MD.
 * When Azure Document Intelligence is enabled globally, all file types go through Azure.
 *
 * @param {Buffer}  buffer   — file bytes
 * @param {string}  mime     — MIME type
 * @param {string}  filename — original file name
 * @returns {Promise<{ text: string, meta: { pageCount: number|null, sheetNames: string[]|null, pages?: Array<{pageNumber:number, text:string}> } }>}
 *   `text` is byte-for-byte what extractFileContent() used to return; `meta`
 *   feeds documents.page_count / sheet_count and (later) per-chunk page numbers.
 */
async function extractFileContentWithMeta(buffer, mime, filename) {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    const meta = { pageCount: null, sheetNames: null };

    log.info(`[KBHelpers] ─── File: ${filename} (${(buffer.length / 1024).toFixed(1)} KB, ${mime}) ───`);
    log.info(`[KBHelpers] Mode: ${useAzure ? '☁️  AZURE' : '🖥️  LOCAL'}`);

    // ── Azure Document Intelligence path (all file types) ──
    if (useAzure) {
        const azure = require('../documents/azureDocIntelligence');
        if (!(await azure.isAzureDocIntelligenceConfigured())) {
            throw new Error('Azure Document Intelligence is not configured. Set endpoint and key in admin settings.');
        }
        log.info(`[KBHelpers] Extraction: Azure Document Intelligence (Layout → Markdown)`);
        if (isSpreadsheetFile(mime, filename)) meta.sheetNames = readSheetNames(buffer);
        // extractWithAzureWithStats is the { text, pageCount } variant; until
        // it lands the page count is simply unknown (null), never wrong.
        if (typeof azure.extractWithAzureWithStats === 'function') {
            const r = await azure.extractWithAzureWithStats(buffer, filename);
            return {
                text: r?.text || '',
                meta: {
                    ...meta,
                    pageCount: Number.isFinite(r?.pageCount) ? r.pageCount : null,
                    // Azure splits on its own PageBreak markers now, so the KB
                    // ingest can stamp a page on each chunk. Absent when the
                    // document had no breaks at all — one page, or none.
                    ...(Array.isArray(r?.pages) && r.pages.length > 0 ? { pages: r.pages } : {}),
                },
            };
        }
        return { text: await azure.extractWithAzure(buffer, filename), meta };
    }

    // ── Local extraction path ──
    if (mime === 'text/plain' || mime === 'text/markdown') {
        log.info(`[KBHelpers] Extraction: Direct text read (${mime})`);
        return { text: buffer.toString('utf-8'), meta };
    }

    if (mime === 'application/pdf') {
        let content = '';
        let pages;

        // Primary: pdfjs-dist for text-based PDFs. The stats variant yields the
        // identical joined text plus per-page text and the page count.
        try {
            const { extractTextFromPDFWithStats } = require('../documents/pdfExtractor');
            const r = await extractTextFromPDFWithStats(buffer, filename);
            content = r?.text || '';
            if (Number.isFinite(r?.numPages) && r.numPages > 0) meta.pageCount = r.numPages;
            if (Array.isArray(r?.pages) && r.pages.length > 0) pages = r.pages;
            if (content && content.trim().length >= 20) {
                log.info(`[KBHelpers] Extraction: pdfjs-dist (text-based PDF, ${meta.pageCount ?? '?'} pages)`);
            }
        } catch (e) {
            log.warn('[KBHelpers] pdfExtractor failed:', e.message);
        }

        if (!content || content.trim().length < 10) {
            throw new Error('Could not extract text from PDF. Enable Azure Document Intelligence for scanned documents, or ensure the PDF has a text layer.');
        }
        return { text: content, meta: pages ? { ...meta, pages } : meta };
    }

    // DOCX, PPTX, CSV, XLSX, etc.
    if (
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mime === 'text/csv' ||
        mime === 'application/csv' ||
        XLSX_MIMES.has(mime) ||
        filename?.match(/\.(docx|pptx|csv|xlsx|xls)$/i)
    ) {
        const { parseDocument } = require('../documents/documentParser');
        log.info(`[KBHelpers] Extraction: documentParser (${filename.split('.').pop()})`);
        if (isSpreadsheetFile(mime, filename)) meta.sheetNames = readSheetNames(buffer);
        return { text: await parseDocument(buffer, mime, filename), meta };
    }

    // Generic fallback via documentParser
    try {
        const { parseDocument, isSupportedDocument } = require('../documents/documentParser');
        if (isSupportedDocument && isSupportedDocument(mime, filename)) {
            log.info(`[KBHelpers] Extraction: documentParser (generic)`);
            return { text: await parseDocument(buffer, mime, filename), meta };
        }
    } catch (e) {
        log.warn('[KBHelpers] documentParser fallback failed:', e.message);
    }

    throw new Error(`Unsupported file type: ${mime}`);
}

/**
 * Text-only wrapper around extractFileContentWithMeta — the signature every
 * existing call site (ingest.js, notebook/webpage sourceIngestion) uses.
 * @returns {Promise<string>} extracted text/markdown content
 */
async function extractFileContent(buffer, mime, filename) {
    const { text } = await extractFileContentWithMeta(buffer, mime, filename);
    return text;
}

/**
 * Fetch a URL and return its content as clean Markdown.
 *
 * Strategy:
 *   1. Simple HTTP fetch + htmlToMarkdown (fast, works for most sites)
 *   2. If content < 20 chars → Playwright headless browser fallback (handles SPAs)
 *
 * @param {string} url — the URL to fetch
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchUrlContent(url) {
    // SSRF guard — block private/loopback/link-local hosts (AWS metadata,
    // localhost services, etc.) before opening the socket.
    const parsedUrl = await assertUrlIsPublic(url);

    // ── Step 1: Simple HTTP fetch (fast path) ────────────────────
    let content = '', pageTitle = '', resolvedUrl = url;

    try {
        // safeFetch, not the global fetch. assertUrlIsPublic above resolves DNS
        // to validate, then a plain fetch() resolves DNS AGAIN to connect — and
        // a hostile name server can answer those two lookups differently (DNS
        // rebinding), so the check passes on a public IP and the socket lands on
        // 169.254.169.254. safeFetch revalidates inside the connect handler, on
        // the initial request and on every redirect hop, so both rebinding and
        // redirect laundering fail at the socket instead of after the fact.
        const { safeFetch } = require('../../utils/ssrfGuard');
        const response = await safeFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            throw new Error(`Fetch failed: HTTP ${response.status}`);
        }

        resolvedUrl = response.url || url;
        // Redirect-target re-validation: even though the initial host passed,
        // a chain of 3xx responses could have hopped into an internal host.
        if (resolvedUrl !== url) {
            await assertUrlIsPublic(resolvedUrl);
        }
        const html = await response.text();
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
            const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
            content = result.markdown;
            pageTitle = result.title || parsedUrl.hostname;
            if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                content = `# ${pageTitle}\n\n${content}`;
            }
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = html;
            pageTitle = parsedUrl.hostname;
        } else {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    } catch (fetchErr) {
        // If even the basic fetch fails, try headless browser directly
        log.info(`[KBHelpers] Simple fetch failed for ${url}: ${fetchErr.message}, trying headless browser...`);
        content = '';
    }

    // ── Step 2: Playwright headless fallback (for SPAs / JS-rendered pages) ──
    if (!content || content.trim().length < 20) {
        log.info(`[KBHelpers] Content too short (${content.trim().length} chars), using Playwright headless browser for: ${url}`);
        try {
            const result = await fetchWithPlaywright(url);
            content = result.content;
            pageTitle = result.title || pageTitle || parsedUrl.hostname;
            resolvedUrl = result.resolvedUrl || resolvedUrl;
            log.info(`[KBHelpers] Playwright extracted ${content.length} chars from ${url}`);
        } catch (pwErr) {
            log.error(`[KBHelpers] Playwright fallback failed for ${url}:`, pwErr.message);
            throw new Error(`No meaningful content extracted from URL (simple fetch and headless browser both failed)`);
        }
    }

    if (!content || content.trim().length < 20) {
        throw new Error('No meaningful content extracted from URL');
    }

    // Truncate very long pages
    const maxChars = 200000;
    if (content.length > maxChars) {
        content = content.slice(0, maxChars);
    }

    return { content, title: pageTitle, resolvedUrl };
}

/**
 * Fetch URL content using a remote headless Chromium (via browserProvider).
 * Waits for the page to load + JS to render, then extracts the HTML.
 *
 * The browser runs in an isolated container, so navigating to arbitrary
 * user-supplied URLs never happens inside the API process.
 *
 * SSRF: the caller validates the initial URL (assertUrlIsPublic) before this
 * runs, but a JS-rendered page can itself issue further requests — redirects,
 * XHR/fetch, iframes — that a plain-fetch flow never triggers. So every
 * request Chromium makes for this navigation is re-screened via
 * context.route(), and the final page.url() is re-checked once navigation
 * settles, mirroring the redirect re-check in fetchUrlContent() above.
 *
 * @param {string} url
 * @param {Object}   [opts]
 * @param {(base64Jpeg: string) => void} [opts.onFrame] - called on each
 *   throttled screenshot while the page loads (chat live preview). Omit for
 *   the default KB-ingestion behavior (no screenshots taken).
 * @param {string}   [opts.waitForSelector] - CSS selector to wait for before
 *   extracting content; best-effort, a timeout here is swallowed.
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchWithPlaywright(url, opts = {}) {
    const browserProvider = require('../../services/browserProvider');
    const { isPrivateHostname, isPrivateIp } = require('../../utils/ssrfGuard');

    return browserProvider.withContext(
        {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        async (context) => {
            await context.route('**/*', (route) => {
                let target;
                try { target = new URL(route.request().url()); } catch (_) { return route.abort('blockedbyclient'); }
                if (!['http:', 'https:'].includes(target.protocol)) return route.abort('blockedbyclient');
                if (isPrivateHostname(target.hostname) || isPrivateIp(target.hostname)) return route.abort('blockedbyclient');
                return route.continue();
            });

            const page = await context.newPage();

            let frameTimer = null;
            if (typeof opts.onFrame === 'function') {
                let capturing = false;
                frameTimer = setInterval(async () => {
                    if (capturing) return;
                    capturing = true;
                    try {
                        const buf = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 2000 });
                        opts.onFrame(buf.toString('base64'));
                    } catch (_) { /* mid-navigation or page closed — skip this tick */ }
                    finally { capturing = false; }
                }, 350);
            }

            try {
                // domcontentloaded, not networkidle: many real-world sites never
                // go fully idle (continuous analytics/tracking beacons, chat
                // widgets polling), which would throw a timeout here and abandon
                // an otherwise perfectly-loaded page. Settle for JS rendering is
                // handled below as a best-effort wait that can't fail the fetch.
                let downloadTriggered = false;
                try {
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                    });
                } catch (navErr) {
                    // A direct link to a file (PDF, zip, ...) makes Playwright
                    // reject navigation instead of loading a page — that's not a
                    // broken fetch, it's the wrong tool for a non-HTML resource.
                    if (/download is starting/i.test(navErr.message)) downloadTriggered = true;
                    else throw navErr;
                }
                if (downloadTriggered) {
                    throw new Error('This URL triggers a file download (e.g. a PDF) rather than rendering a webpage — a headless browser cannot read downloaded files this way.');
                }

                // Best-effort settle for JS-rendered content; don't fail the
                // whole fetch just because the page never goes fully idle.
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

                const resolvedUrl = page.url();
                let resolvedHost = '';
                try { resolvedHost = new URL(resolvedUrl).hostname; } catch (_) { /* keep empty */ }
                if (isPrivateHostname(resolvedHost) || isPrivateIp(resolvedHost)) {
                    throw new Error(`Navigation resolved to a private/internal address (${resolvedHost})`);
                }

                if (opts.waitForSelector) {
                    await page.waitForSelector(opts.waitForSelector, { timeout: 5000 }).catch(() => {});
                }

                // Additional wait for late-rendering SPAs
                await page.waitForTimeout(1500);

                const pageTitle = await page.title();

                // Get the fully rendered HTML
                const html = await page.content();

                // Convert rendered HTML to markdown
                const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
                const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
                let content = result.markdown;

                if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                    content = `# ${pageTitle}\n\n${content}`;
                }

                return {
                    content,
                    title: result.title || pageTitle,
                    resolvedUrl,
                };
            } finally {
                if (frameTimer) clearInterval(frameTimer);
            }
        }
    );
}

// ── Ingest funnel ───────────────────────────────────────────────────

/**
 * Is a hash/simhash hit a duplicate *within the same source* (refuse, as
 * before) or an overlap *across sources* (annotate, keep going)?
 *
 * No source on either side means the caller (or the matched row) predates the
 * source model; that keeps the historical KB-wide dedup for every legacy call
 * site — the conservative answer is to refuse, never to embed twice.
 */
function isSameSourceScope(existingSourceId, sourceId) {
    if (!sourceId || !existingSourceId) return true;
    return String(existingSourceId) === String(sourceId);
}

function byteLength(content) {
    try { return Buffer.byteLength(String(content), 'utf8'); } catch (_) { return null; }
}

/** Exact-hash lookup that tolerates the older store shape (id only). */
async function findActiveByHash(kbId, hash) {
    if (typeof kbStore.findDocumentByContentHash === 'function') {
        return kbStore.findDocumentByContentHash(kbId, hash);
    }
    const id = await kbStore.hasContentHash(kbId, hash);
    return id ? { id, source_id: null } : null;
}

/** Local ingestion embeds with the configured model; the search service uses its own. */
const isLocalIngest = (azureParams, kbProvider) => !!azureParams.use_azure || kbProvider === 'local';

/** Does this instance embed knowledge locally (and so with the configured model)? */
async function usesLocalIngest() {
    const { resolveKbProvider } = require('./resolveProvider');
    return isLocalIngest(await getAzureIngestParams(), await resolveKbProvider());
}

/**
 * Chunk + embed `content` for an existing documents row. Local dispatcher or
 * the search-service depending on org config. Throws on failure; the caller
 * decides whether the row is deleted (legacy) or marked 'error' (record mode).
 * @returns {Promise<number>} chunks created
 */
async function embedDocumentContent(tenantId, kbId, docId, content, { title, sourceUri, lang, pages = null }) {
    const azureParams = await getAzureIngestParams();
    const { resolveKbProvider } = require('./resolveProvider');
    const kbProvider = await resolveKbProvider();
    const useLocalIngest = isLocalIngest(azureParams, kbProvider);

    if (useLocalIngest) {
        // ── Local ingestion path ─────────────────────────────────────
        // Chunk + embed locally via the embedding dispatcher in
        // localKBIngest (configured provider → Azure → CPU). Bypasses
        // the external search-service entirely.
        log.info(`[KBHelpers] Embedding: local dispatcher (kb_provider=${kbProvider}${azureParams.use_azure ? ', use_azure=true' : ''})`);
        log.info(`[KBHelpers] Chunking + embedding ${content.length} chars locally`);
        try {
            const { ingestLocally } = require('./localKBIngest');
            // `pages` present, each chunk gets the page its text starts on and
            // a citation can say "p. 12". Only the local path can do this: the
            // search-service chunks on its own side and never sees the pages.
            const result = await ingestLocally(tenantId, kbId, docId, content, { title, sourceUri, lang, pages });
            return result.chunks_created || 0;
        } catch (localErr) {
            log.error('[KBHelpers] Local ingestion failed:', localErr.message);
            throw new Error(`Local ingestion failed: ${localErr.message}`);
        }
    }

    // ── Search-service path (non-Azure) ──────────────────────────
    log.info(`[KBHelpers] Embedding: Local vLLM (bge-m3) via search-service`);
    log.info(`[KBHelpers] Sending ${content.length} chars to search-service`);

    const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
        method: 'POST',
        headers: getServiceHeaders(),
        body: JSON.stringify({
            tenant_id: tenantId,
            knowledge_base_id: kbId,
            document_id: docId,
            content,
            title,
            source_uri: sourceUri,
            lang,
            ...azureParams,
        }),
        signal: AbortSignal.timeout(120000)
    });

    if (!ingestRes.ok) {
        const err = await ingestRes.text();
        throw new Error(`Search-service ingestion failed: ${err}`);
    }
    const result = await ingestRes.json();
    return result.chunks_created || 0;
}

/**
 * Ingest text content into a KB.
 *
 * Handles: deduplication check → document record creation → chunking + embedding.
 *
 * @param {string}  tenantId  — user ID
 * @param {string}  kbId      — knowledge base ID
 * @param {string}  content   — text/markdown content
 * @param {string}  title     — document title
 * @param {string}  sourceType — 'text' | 'web' | 'upload' | 'notebook_source' | …
 * @param {string|null} sourceUri — source identifier (filename, URL, source ID)
 * @param {object}  [options]
 * @param {boolean} [options.skipDedup=false] - skip deduplication check
 * @param {string}  [options.lang='auto']    - language hint
 * @param {object}  [options.metadata]       - rich metadata (sender, threadId, …)
 * @param {number}  [options.simhashDistance=3]
 * @param {string}  [options.sourceId]       - kb_sources.id the document belongs to
 * @param {string}  [options.externalId]     - id in the external system (NC fileid, row id, URL, …)
 * @param {Date|string} [options.sourceModifiedAt]
 * @param {number}  [options.sizeBytes]      - defaults to the UTF-8 size of `content`
 * @param {string}  [options.mime]
 * @param {number}  [options.pageCount]
 * @param {number}  [options.sheetCount]
 * @param {string}  [options.createdBy]      - user id (null for engine-driven ingests)
 * @param {'processed'|'redacted'} [options.status='processed'] - K4 passes 'redacted'
 * @param {string}  [options.piiStatus]      - 'none'|'found'|'redacted'|'unscanned'
 * @param {object}  [options.piiCategories]
 * @param {string}  [options.extractSummary]
 * @param {'throw'|'record'} [options.onFailure='throw'] - 'record' keeps a
 *   documents row with status 'skipped' | 'error' | 'duplicate' (+ status_reason)
 *   and RESOLVES with { document, chunks:0, status, error } instead of throwing,
 *   so a source refresh can keep going and the UI can show "36 of 38 processed".
 *
 * Duplicates: an exact or near match INSIDE the same source is refused as
 * before (DUPLICATE / NEAR_DUPLICATE, alias row recorded with status
 * 'duplicate'); a match in ANOTHER source is annotated on the new row
 * (overlaps_document_id) and ingested anyway — K4 shows "overlaps with …".
 *
 * @returns {Promise<{document: object, chunks: number, status: string, overlapsDocumentId?: string|null, duplicateOf?: string, error?: string}>}
 */
async function ingestDocument(tenantId, kbId, content, title, sourceType, sourceUri, options = {}) {
    const {
        skipDedup = false, lang = 'auto', metadata = null, simhashDistance = 3,
        sourceId = null, externalId = null, sourceModifiedAt = null, sizeBytes = null, mime = null,
        pageCount = null, sheetCount = null, createdBy = null,
        /**
         * The extractor's `pages[]`, when it produced any (PDFs, mostly).
         *
         * Its own option rather than a field on `privacy`: a document's pages
         * are a property of the DOCUMENT. The Privacy Shield happens to want
         * them too, and reading one feature's option bag for another feature's
         * data is how a shield that gets turned off takes page numbers with it.
         */
        pages = null,
        status: requestedStatus = 'processed', piiStatus, piiCategories, extractSummary,
        onFailure = 'throw',
        /**
         * Privacy Shield at ingest (K4). `{ orgId, userId, pages? }` runs the
         * text through `core/kb/ingestPrivacy` BEFORE it is hashed; `null`
         * opts out.
         *
         * Opt-IN rather than opt-out on purpose. The notebook and webpage
         * source ingests already scan with their own policy and deliberately
         * keep the real text, and silently redacting underneath them would
         * change what those features store without anybody asking for it.
         */
        privacy = null,
    } = options;
    const record = onFailure === 'record';
    // `let`: the privacy screen below may turn a 'processed' ingest into a
    // 'redacted' one, and this is derived before that runs.
    let okStatus = requestedStatus === 'redacted' ? 'redacted' : 'processed';
    const extra = {
        sourceId, externalId, sourceModifiedAt, mime, pageCount, sheetCount, createdBy,
        piiStatus, piiCategories, extractSummary,
        sizeBytes: sizeBytes != null ? sizeBytes : byteLength(content),
    };

    if (!content || content.trim().length < 3) {
        const err = new Error('Content is too short (min 3 chars)');
        if (record) {
            const doc = await kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
                ...extra, status: 'skipped', statusReason: friendlyError(err),
            });
            return { document: doc, chunks: 0, status: 'skipped', error: err.message };
        }
        throw err;
    }

    /**
     * ── PRIVACY BEFORE THE HASH ─────────────────────────────────────
     * The order matters and is not interchangeable. Dedup is a hash of the
     * content, and what gets STORED is the redacted text — so hashing first
     * would fingerprint text that is never written anywhere, and the same
     * file uploaded twice would produce two rows with one hash and two
     * different bodies. Screening first makes the fingerprint describe the
     * thing it is a fingerprint OF.
     *
     * A `block` decision returns here: the row is kept with its reason and no
     * content, which is what makes a held document visible instead of a file
     * that silently never arrived.
     */
    let piiStatusOut = piiStatus;
    let piiCategoriesOut = piiCategories;
    if (privacy && privacy.orgId !== undefined) {
        const { applyShield, OUTCOME } = require('./ingestPrivacy');
        const verdict = await applyShield({
            orgId: privacy.orgId || null,
            userId: privacy.userId || null,
            text: content,
            filename: title,
            pages: privacy.pages || null,
        });
        piiStatusOut = verdict.piiStatus;
        piiCategoriesOut = verdict.piiCategories;
        if (verdict.outcome === OUTCOME.SKIPPED) {
            const doc = await kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
                ...extra, piiStatus: piiStatusOut, piiCategories: piiCategoriesOut,
                status: 'skipped', statusReason: verdict.reason,
            });
            return { document: doc, chunks: 0, status: 'skipped', error: verdict.reason };
        }
        // From here on, `content` IS the text that will be hashed, chunked,
        // embedded and stored. There is no copy of the original.
        content = verdict.text;
        extra.sizeBytes = sizeBytes != null ? sizeBytes : byteLength(content);
        if (verdict.outcome === OUTCOME.REDACTED) okStatus = 'redacted';
    }
    extra.piiStatus = piiStatusOut;
    extra.piiCategories = piiCategoriesOut;

    const hash = kbStore.hashContent(content);
    let overlapsDocumentId = null;

    // ── Exact-hash dedup ──
    if (!skipDedup) {
        const existing = await findActiveByHash(kbId, hash);
        if (existing) {
            if (isSameSourceScope(existing.source_id, sourceId)) {
                // Record the alias (duplicate_of pointer) so the UI shows the
                // attempt, but do NOT re-embed — the canonical doc's chunks cover it.
                let dupRow = null;
                try {
                    if (kbStore.recordDuplicate) {
                        dupRow = await kbStore.recordDuplicate(tenantId, kbId, title, sourceType, sourceUri, hash, existing.id, metadata, {
                            ...extra, statusReason: 'Identical content already in this knowledge base',
                        });
                    }
                } catch (_) { /* non-fatal */ }
                if (record) return { document: dupRow, chunks: 0, status: 'duplicate', duplicateOf: existing.id };
                throw Object.assign(new Error('Duplicate content already exists in this KB'), {
                    code: 'DUPLICATE', documentId: existing.id
                });
            }
            overlapsDocumentId = existing.id;
        }
    }

    // ── SimHash near-duplicate probe (e.g. newsletters with tiny variations) ──
    // Skip in skipDedup mode (category_merge re-ingests deliberately) and when
    // the exact match already told us the answer.
    const simhash = simhash64(content);
    if (!skipDedup && !overlapsDocumentId && simhash != null && kbStore.findNearDuplicateBySimhash) {
        let near = null;
        try { near = await kbStore.findNearDuplicateBySimhash(kbId, simhash, simhashDistance); }
        catch (_) { near = null; /* simhash failure shouldn't block ingestion */ }
        if (near) {
            if (isSameSourceScope(near.source_id, sourceId)) {
                let dupRow = null;
                try {
                    if (kbStore.recordDuplicate) {
                        dupRow = await kbStore.recordDuplicate(tenantId, kbId, title, sourceType, sourceUri, hash, near.id, metadata, {
                            ...extra, statusReason: 'Near-identical content already in this knowledge base',
                        });
                    }
                } catch (_) { /* non-fatal */ }
                if (record) return { document: dupRow, chunks: 0, status: 'duplicate', duplicateOf: near.id };
                throw Object.assign(new Error('Near-duplicate content already in KB'), {
                    code: 'NEAR_DUPLICATE', documentId: near.id
                });
            }
            overlapsDocumentId = near.id;
        }
    }

    // Create document record (with rich metadata + simhash + provenance)
    const doc = await kbStore.createDocument(
        tenantId, kbId, title, sourceType, sourceUri, hash, 0, metadata, simhash,
        { ...extra, overlapsDocumentId, status: okStatus }
    );

    // Send for chunking + embedding
    let chunks = 0;
    try {
        chunks = await embedDocumentContent(tenantId, kbId, doc.id, content, { title, sourceUri, lang, pages });
    } catch (embedErr) {
        if (record) {
            let errDoc = null;
            try {
                errDoc = await kbStore.updateDocumentStatus(doc.id, { status: 'error', statusReason: friendlyError(embedErr), chunkCount: 0 });
            } catch (_) { /* best-effort */ }
            return { document: errDoc || { ...doc, status: 'error' }, chunks: 0, status: 'error', error: embedErr.message };
        }
        // Legacy contract: no row survives a failed ingest. The row never held
        // content, so there is nothing worth snapshotting.
        await kbStore.deleteDocument(doc.id, { skipSnapshot: true });
        throw embedErr;
    }

    await kbStore.updateChunkCount(doc.id, chunks);
    await kbStore.bumpKBVersion(kbId);

    return {
        document: { ...doc, chunk_count: chunks },
        chunks,
        status: okStatus,
        overlapsDocumentId,
    };
}

/**
 * Record an ingest that never reached ingestDocument (extraction failed,
 * unsupported type, blocked by the shield) as a documents row with status
 * 'skipped' | 'error', so the source shows the file and why it is missing.
 * Never throws on a bad reason; the row is the point.
 *
 * @param {object} p — { tenantId, kbId, title, sourceType, sourceUri, status='error',
 *   error (Error|string) | reason, sourceId, externalId, sizeBytes, mime, createdBy, metadata }
 */
async function recordFailedDocument({ tenantId, kbId, title, sourceType, sourceUri = null, status = 'error', error = null, reason = null, metadata = null, ...extra } = {}) {
    const st = status === 'skipped' ? 'skipped' : 'error';
    const statusReason = reason ? String(reason) : friendlyError(error || 'Processing failed');
    return kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
        ...extra, status: st, statusReason,
    });
}

/**
 * Remove a document's chunks (local kb_chunks + remote search-service) WITHOUT
 * touching the documents row. Refresh-in-place and source-driven cleanups use
 * this; deleteDocumentChunks below adds the row deletion.
 *
 * ── `strict` MAAKT VAN "GEPROBEERD" EEN "GELUKT" ─────────────────────
 * Zonder `strict` werd het antwoord van de search-service nooit gelezen: een
 * 500, een 404 of een time-out kwam als een `console.warn` voorbij en de
 * aanroeper ging vrolijk verder met het weghalen van de documentrij. Voor een
 * herindexering is dat te verdedigen (de chunks worden zo meteen toch
 * vervangen), maar voor een VERWIJDERING is het precies de bug die dit hele
 * pad wil voorkomen: tekst weg van het scherm, embeddings nog doorzoekbaar.
 * `deleteDocumentChunks` zet daarom `strict: true` — dan gooit een niet-ok
 * antwoord, en die fout landt in `errors` van purgeSourceDocuments, wat
 * `complete: false` oplevert en de bronrij laat staan.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] gooi als de remote opruiming niet
 *   aantoonbaar is gelukt, i.p.v. te waarschuwen.
 */
async function purgeDocumentChunks(kbId, docId, tenantId, { strict = false } = {}) {
    // Clean up local kb_chunks (for Azure-path ingested docs)
    try {
        const { deleteChunksLocally } = require('./localKBIngest');
        await deleteChunksLocally(tenantId, kbId, docId);
    } catch (_) { /* table may not exist yet — that's fine */ }

    // Also clean up via remote search-service (skip when admin chose local-only)
    try {
        const { resolveKbProvider } = require('./resolveProvider');
        const kbProvider = await resolveKbProvider();
        if (kbProvider !== 'local') {
            // DELETE /kb/documents/{id} — the only chunk-removal route the
            // search-service has (search-service/app/routers/ingest.py), and
            // the one the Node shim in routes/search.js now mirrors. The
            // previous path (/kb/{kb}/documents/{doc}/chunks) existed on
            // neither, so remote chunks were never actually deleted.
            const qs = `tenant_id=${encodeURIComponent(tenantId)}&knowledge_base_id=${encodeURIComponent(kbId)}`;
            const res = await fetch(`${SEARCH_SERVICE_URL}/kb/documents/${encodeURIComponent(docId)}?${qs}`, {
                method: 'DELETE',
                headers: getServiceHeaders(),
                signal: AbortSignal.timeout(10000)
            });
            // Een 404 is hier "staat er niet meer" en dus klaar; alles daarboven
            // is een mislukte opruiming. `res` kan bij een oude fetch-double
            // ontbreken — dan is er niets aantoonbaar en versmalt dat in strict.
            if (res && res.ok === false && res.status !== 404) {
                throw new Error(`search-service returned ${res.status}`);
            }
            if (strict && (!res || typeof res.ok !== 'boolean')) {
                throw new Error('search-service gave no readable answer');
            }
        }
    } catch (e) {
        if (strict) throw new Error(`chunk cleanup failed for document ${docId}: ${e.message}`);
        log.warn('[KBHelpers] Search-service chunk cleanup failed:', e.message);
    }
}

/**
 * Refresh-in-place: re-chunk + re-embed `content` for an EXISTING documents
 * row. The row — and therefore documents.id, citations and the version
 * history — is kept; only the chunks and the fingerprint/bookkeeping columns
 * change. No kb_document_versions snapshot is written: the source of truth
 * for a source-driven document is the external system, not the audit table.
 *
 * "Process again" on a skipped/error row is the same call: it turns the row
 * into a processed one under the same id.
 *
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} docId
 * @param {string} content
 * @param {object} [options] - same keys as ingestDocument: title, lang, metadata,
 *   externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount, status,
 *   piiStatus, piiCategories, extractSummary, onFailure ('throw' | 'record')
 * @returns {Promise<{document: object, chunks: number, status: string, error?: string}>}
 */
async function reingestDocument(tenantId, kbId, docId, content, options = {}) {
    const {
        title, lang = 'auto', metadata, externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
        status: requestedStatus = 'processed', piiStatus, piiCategories, extractSummary, onFailure = 'throw',
        // The extractor's pages, so a re-ingest stamps page numbers the same
        // way a first ingest does. A refresh is how an already-ingested source
        // GAINS pages it never had.
        pages = null,
    } = options;
    const record = onFailure === 'record';
    const okStatus = requestedStatus === 'redacted' ? 'redacted' : 'processed';

    const existing = await kbStore.getDocument(docId);
    if (!existing) throw Object.assign(new Error('Document not found'), { code: 'NOT_FOUND' });
    if (String(existing.knowledge_base_id) !== String(kbId)) {
        throw Object.assign(new Error('Document belongs to another knowledge base'), { code: 'KB_MISMATCH' });
    }
    const docTitle = title || existing.title;
    const sourceUri = existing.source_uri || null;

    if (!content || content.trim().length < 3) {
        const err = new Error('Content is too short (min 3 chars)');
        if (record) {
            await purgeDocumentChunks(kbId, docId, tenantId);
            const doc = await kbStore.replaceDocumentContent(docId, {
                title: docTitle, chunkCount: 0, status: 'skipped', statusReason: friendlyError(err),
                externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
            });
            await kbStore.bumpKBVersion(kbId);
            return { document: doc, chunks: 0, status: 'skipped', error: err.message };
        }
        throw err;
    }

    const hash = kbStore.hashContent(content);
    const simhash = simhash64(content);

    // Old chunks go first: ingestLocally replaces per document inside its own
    // transaction, but the search-service path appends.
    await purgeDocumentChunks(kbId, docId, tenantId);

    let chunks = 0;
    try {
        chunks = await embedDocumentContent(tenantId, kbId, docId, content, { title: docTitle, sourceUri, lang, pages });
    } catch (embedErr) {
        if (record) {
            let errDoc = null;
            try {
                errDoc = await kbStore.replaceDocumentContent(docId, {
                    title: docTitle, chunkCount: 0, status: 'error', statusReason: friendlyError(embedErr),
                    externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
                });
            } catch (_) { /* best-effort */ }
            await kbStore.bumpKBVersion(kbId);
            return { document: errDoc || { ...existing, status: 'error', chunk_count: 0 }, chunks: 0, status: 'error', error: embedErr.message };
        }
        // Row stays (it is the caller's row), but its chunks are gone: say so.
        try { await kbStore.updateDocumentStatus(docId, { status: 'error', statusReason: friendlyError(embedErr), chunkCount: 0 }); } catch (_) { /* best-effort */ }
        throw embedErr;
    }

    const doc = await kbStore.replaceDocumentContent(docId, {
        title: docTitle,
        contentHash: hash,
        simhash,
        chunkCount: chunks,
        sizeBytes: sizeBytes != null ? sizeBytes : byteLength(content),
        pageCount, sheetCount, mime, sourceModifiedAt, externalId,
        status: okStatus,
        statusReason: null,
        // It has chunks of its own now; it is nobody's alias any more. A row
        // once marked duplicate (a table row the text filter mistook for its
        // neighbour) comes back through here when the source is re-read.
        duplicateOf: null,
        extractSummary, piiStatus, piiCategories,
        metadata,
    });
    await kbStore.bumpKBVersion(kbId);
    return { document: doc, chunks, status: okStatus };
}

/**
 * Delete a document's chunks from the search-service, then remove
 * the document record from the DB.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} docId    — document ID
 * @param {string} tenantId — user ID
 * @param {object} opts     — optional flags
 * @param {boolean} opts.skipSnapshot — skip the kb_document_versions snapshot.
 *   Pass true when the caller has already snapshotted (route handlers do, to
 *   carry the user id) AND for every SOURCE-DRIVEN removal (a file vanished
 *   from the folder, a row from the table, a page from the crawl, a re-index):
 *   there the external system is the source of truth, and a snapshot per
 *   refresh would fill an audit table that has no erasure path. Default
 *   false — a human deleting a document through the API still gets the
 *   recovery snapshot.
 */
async function deleteDocumentChunks(kbId, docId, tenantId, { skipSnapshot = false } = {}) {
    // strict: dit is de verwijdering, niet een herindexering. Lukt de remote
    // opruiming niet, dan mag de documentrij NIET vallen — anders blijven de
    // embeddings doorzoekbaar zonder dat er nog een rij is om ze aan te wijzen.
    await purgeDocumentChunks(kbId, docId, tenantId, { strict: true });
    await kbStore.deleteDocument(docId, { skipSnapshot });
    await kbStore.bumpKBVersion(kbId);
}

function docColumns() {
    return Array.isArray(kbStore.DOCUMENT_COLUMNS) ? kbStore.DOCUMENT_COLUMNS.join(', ') : '*';
}

/**
 * Find the KB document record that was created for a notebook source.
 * During ingestion, notebook sources store the source ID as `source_uri`.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} sourceId — notebook source ID
 * @returns {Promise<object|null>} document row (projected) or null
 */
async function findDocumentBySourceUri(kbId, sourceId) {
    const { getOne } = require('../../db');
    return await getOne(
        `SELECT ${docColumns()} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
        [kbId, sourceId]
    );
}

/**
 * All documents for a source, not just the first.
 *
 * Re-ingesting a source (the retry button, or a duplicate add) can leave more
 * than one `documents` row with the same source_uri. Cleanup that resolved only
 * ONE of them deleted that row's chunks and orphaned the rest — embeddings of
 * deleted content stayed searchable, which in a privacy product means deleted
 * text keeps coming back in answers.
 *
 * K1: also keyed on (source_id, external_id) — pass `opts.sourceId` and
 * `opts.externalId` and rows matching EITHER the legacy source_uri OR the
 * (source, external id) pair are returned (duplicate alias rows excluded on
 * the latter, they share the canonical row's external id).
 *
 * @param {string} kbId
 * @param {string|null} sourceUri
 * @param {object} [opts]
 * @param {string} [opts.sourceId]
 * @param {string} [opts.externalId]
 */
async function findDocumentsBySourceUri(kbId, sourceUri, { sourceId = null, externalId = null } = {}) {
    const { getAll } = require('../../db');
    const byPair = sourceId && externalId != null;
    if (!byPair) {
        return await getAll(
            `SELECT ${docColumns()} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
            [kbId, sourceUri]
        );
    }
    return await getAll(
        `SELECT ${docColumns()} FROM documents
          WHERE knowledge_base_id = $1
            AND (($2::text IS NOT NULL AND source_uri = $2)
                 OR (source_id = $3 AND external_id = $4 AND status <> 'duplicate'))
          ORDER BY created_at DESC`,
        [kbId, sourceUri || null, sourceId, String(externalId)]
    );
}

module.exports = {
    getAzureIngestParams,
    usesLocalIngest,
    extractFileContent,
    extractFileContentWithMeta,
    fetchUrlContent,
    fetchWithPlaywright,
    ingestDocument,
    reingestDocument,
    recordFailedDocument,
    purgeDocumentChunks,
    deleteDocumentChunks,
    findDocumentBySourceUri,
    findDocumentsBySourceUri,
    simhash64,
    assertUrlIsPublic,
    friendlyError,
};
