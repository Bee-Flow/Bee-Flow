---
id: kb-upload
title: A knowledge base ingests an uploaded document
mode: generated+agentic-fallback
tags: [smoke, knowledge]
requires: [search]
timeout: 150000
auth: admin
cleanup: "Delete the knowledge base named 'E2E KB <runId>' created by this run. It is created by the 'New knowledge base' button on /app/studio/knowledge; deleting it also removes its sources and documents. Do this even if an earlier step failed."
---

## Steps

1. Navigate to `/app/studio/knowledge`.
2. Create a new knowledge base with the `kb-create` button ("New knowledge base").
   It creates the base AND opens it, so the URL becomes
   `/app/studio/knowledge/<id>/sources` in one step — there is no create form.
3. Rename it to `E2E KB <runId>` by clicking the name in the header and typing.
4. On the Sources tab (`kb-tab-sources`), click `kb-add-kind-upload` and set
   `fixtures-data/sample.md` on the file input labelled "Choose files".
   The upload starts on pick and the server answers 202.
5. Open the upload source's row (`kb-source-row`) to reach the source detail
   (`kb-source-detail`).
6. Wait until the document's row (`kb-doc-row`) reaches
   `data-status="processed"` (or `"redacted"`, if Privacy Shield replaced
   something in it — both mean it was ingested).
7. Clean up: delete the knowledge base.

## Expected

- The knowledge base is created and its Sources tab opens without errors.
- The uploaded document appears as a `kb-doc-row` and reaches
  `data-status="processed"` or `"redacted"` within the timeout (ingestion +
  extraction only — semantic retrieval is a separate scenario gated behind
  `search-retrieval`).
- Cleanup leaves no `E2E KB` entries behind.

## Notes for generation

- Follow the app map's "Knowledge base" section exactly. The legacy
  `kb-create-btn` testid belongs to a DIFFERENT surface and must not be used.
- **Never wait for a chunk count.** Chunks are gone from Studio entirely; the
  document's `data-status` is the completion signal, and a spec that polls for
  "N chunks" will time out every run.
- Uploads: `setInputFiles` on the input labelled "Choose files"; resolve the
  fixture path relative to the spec file (`../../fixtures-data/sample.md`).
- Processing is asynchronous and the list polls itself every 3s — assert
  eventually on `data-status`, never `waitForTimeout`.
- After the create, assert the URL carries a real persisted id and a tab
  segment (e.g. `/\/app\/studio\/knowledge\/[^/?#]+\/sources/`).
- Deletes go through the in-app confirm dialog (`role=alertdialog`), NOT a
  native `window.confirm` — do not register a `page.on('dialog')` handler for
  them; it will never fire and the click will look like it did nothing.
- Scope lookups to the `kb-detail-page` / `kb-source-detail` containers. The
  tabs are `role="radio"` segments, not `role="tab"`.
