# Review FEAT #242, generated share image (Opus, read-only)

Commit 0e604ecfe in the feat-F3 worktree.

Verdict: CHANGES REQUIRED. I found no injection and no SSRF. Two issues are about availability on a public, unauthenticated route, and one is a licence-compliance gap.

## Checked OK

- **SVG injection**: everything interpolated into the SVG is one of the following.
  - Numbers: `toFixed` or `n()`, path commands M/L/Q/C/Z built from glyph coordinates of the bundled fonts.
  - Colours re-validated by `hex()`, which accepts `#rgb` or `#rrggbb` and otherwise uses a fallback.
  - Fixed literals.

  The title, eyebrow and brand are drawn only as outlines and never reach the markup. I probed with markup, quotes and attribute payloads in the text and the colours: none of it reached the SVG.
- **Logo**:
  - The source goes through `assetKeyFromSrc`, which only allows keys under `cms/` in our own storage. There is no URL fetch, so no SSRF.
  - In local mode the storage layer refuses traversal segments in the key.
  - The size is capped at 3 MB while streaming.
  - The format is checked with sharp metadata: only png, jpeg and webp. SVG is never composited.
  - Every sharp call on the logo has `limitInputPixels: 40e6`. The card itself is our own fixed 1200x630 SVG, which has no external references.
  - A logo that fails costs only the logo.
- **URL space**:
  - The route regex allows only `[a-z]{2,3}` for the locale and `[a-z0-9-]` for the slug.
  - The site must be the live site, with a published snapshot, the locale must be published, and the page must exist in the published content. Everything else answers 404 before anything is drawn.
  - The cache key is made from internal data (site, publish time, locale, slug, logo, content), not from the URL, so `?v=` cannot bust the server cache. `v` only chooses the HTTP cache lifetime.
  - The ETag/304 check comes before the render.
- **Concurrency**: at most 2 renders run at a time, at most 40 wait, and past that the answer is a 503 with `Retry-After`. Identical keys are deduplicated while in flight. The LRU is capped at 96 entries and 24 MB.
- **fontkit lockfile**:
  - `package.json` and the root entry in `package-lock.json` agree.
  - `node_modules/fontkit@2.0.4` is not marked dev or optional, because it was already a production transitive dependency.
  - `npm ls fontkit` resolves 2.0.4.
  - `npm ci --dry-run --ignore-scripts` completes.
  - I checked every dependency kind between package.json and the lock: no mismatch.
- **Tests**: each file passes when run alone: ogCard 8/8, cmsOgImage 4/4, seo 53/53, shareImageDesign 2/2, nl migration 3/3. `ShareImageSettings.test.tsx` passes under vitest.

## REQUIRED

1. **Medium: a long title blocks the event loop.** Location: `core/seo/ogText.js:64-87` (`wrap`), `core/seo/ogCard.js:89-97` (`setTitle`), `stores/cms/pages.js:57` (`metaTitle` has no length cap).
   - When a word does not fit, `wrap` shortens it one character at a time, and each step runs a full fontkit layout. That makes the cost grow faster than quadratically with word length.
   - `setTitle` repeats the whole pass up to five times.
   - All of this is synchronous inside `drawPng`, so the concurrency cap does not protect the event loop.
   - Measured on this machine, for one unbroken word of length N:

     | N (characters) | Time |
     |---:|---:|
     | 120 | 0.4 s |
     | 200 | 1.2 s |
     | 500 | 19 s |

     I stopped 2000 after more than 90 s.
   - The text is editor-controlled, but an anonymous GET triggers the render. A page title or `metaTitle` containing, for example, a long URL freezes the whole server once per publish, and again whenever the LRU is cycled.
   - Fix:
     - cap the input to `wrap` and `setTitle` (for example 200 characters after `clean`);
     - find the cut point with a binary search, or with cumulative glyph advances from one layout of the word;
     - stop collecting lines once `maxLines` is passed.
   - Add a test with a 500-character single word and a time budget.

2. **Medium: the logo is loaded on every request, outside the cache and the concurrency cap.** Location: `routes/cmsOgImage.js:313-321`.
   - `loadLogo(design.logo)` is evaluated as an argument to `renderCard`, so it runs before the cache lookup.
   - Every request for a cached card therefore still streams up to 3 MB from storage and runs sharp metadata. Every waiting render holds that buffer: 42 × 3 MB.
   - Neither cost is limited by the 2-render cap.
   - Fix: check the card cache first, and load the logo only on a miss inside the slot. For example:
     - pass a `loadLogo` thunk that `drawPng` calls; or
     - memoise the logo bytes per (site, publish time, logo key), as the card is.

3. **Low (compliance): the SIL OFL licence text is missing.** Location: `server/assets/fonts/`, `THIRD-PARTY-LICENSES.md`.
   - The commit says the faces are OFL. The directory holds only the two `.woff2` files.
   - The name table carries the copyright line and a licence URL, but not the licence text: `licenseDescription` is empty in both subsets.
   - OFL condition 2 requires the copyright notice and the licence to go with every copy, and the server image redistributes these files.
   - Fix:
     - add `server/assets/fonts/OFL-Inter.txt` and `OFL-Fraunces.txt` with the upstream copyright line and licence text;
     - list both faces in `THIRD-PARTY-LICENSES.md`.
   - A subset is a Modified Version. Check upstream that neither project declares a Reserved Font Name. If one does, the subset needs another family name.

## Optional

4. **Rate limiting**: the public route has no rate limiter of its own. With more than 96 page/locale pairs, a crawler that cycles through them keeps both render slots busy. A modest per-IP limiter, or a larger entry cap (cards are about 40 kB), would bound this. The asset route next to it has no limiter either.
5. **Stuck renders**: `slot()` waiters never time out. A stuck sharp call would hold a slot forever. A timeout around `drawPng` would release it.
6. **Unpublished locales**: `publishedLocales` treats any locale key in the page overrides as published. Use the same locale list that `head.js` advertises, so the two cannot drift.
