# Work list: knowledge

Generated from `node scripts/module-boundary.mjs --list` and the core-mode run of the core tests.

## Core -> module import edges (38 in 19 files)

- `core/documents/sheetCells.js`
  - line 151 -> `core/dataEngine/datatableRuntime.js` (datatables)
  - line 153 -> `auth/datatableAccess.js` (datatables)
  - line 154 -> `core/dataEngine/provisionManagedTable.js` (datatables)
  - line 155 -> `stores/datatableStore.js` (datatables)
  - line 156 -> `core/dataEngine/dataModel/managedTables.js` (datatables)
  - line 157 -> `stores/datatableDbStore.js` (datatables)
  - line 158 -> `core/dataEngine/datatableLimits.js` (datatables)
- `core/documents/sheetImport.js`
  - line 116 -> `core/dataEngine/sources/spreadsheetFile/formats/index.js` (datatables)
  - line 123 -> `core/dataEngine/sources/spreadsheetFile/formats/csv.js` (datatables)
  - line 134 -> `core/dataEngine/sources/spreadsheetFile/cells.js` (datatables)
  - line 135 -> `core/dataEngine/sources/spreadsheetFile/formats/sheetjs.js` (datatables)
- `core/integrations/outlookMailbox.mts`
  - line 31 -> `core/dataEngine/dataModel/vocabulary.js` (datatables)
- `core/kb/queryLog/attestation.mts`
  - line 40 -> `stores/dpiaStore.js` (compliance)
- `core/kb/queryLog/csvExport.mts`
  - line 20 -> `core/dataEngine/sources/spreadsheetFile/cells.js` (datatables)
  - line 21 -> `core/dataEngine/sources/spreadsheetFile/formats/csv.js` (datatables)
- `core/kb/sources/cloudFolder.mts`
  - line 105 -> `core/dataEngine/sources/spreadsheetFile/linkerAuth.js` (datatables)
  - line 106 -> `core/dataEngine/sources/spreadsheetFile/providers/index.js` (datatables)
  - line 116 -> `core/dataEngine/sources/spreadsheetFile/providers/documents.js` (datatables)
- `core/kb/sources/index.js`
  - line 89 -> `core/kb/sources/webpage.js` (webpages)
  - line 93 -> `core/kb/sources/datatable.js` (datatables)
- `core/kb/sources/meetingTag.js`
  - line 90 -> `stores/transcriptionStore.js` (meetingNotes)
- `core/kb/sources/syncItem.js`
  - line 170 -> `stores/datatableStore.js` (datatables)
- `core/kb/transcriptOrigin.js`
  - line 46 -> `stores/transcriptionStore.js` (meetingNotes)
- `jobs/kbSourceRefresh.js`
  - line 212 -> `stores/datatableStore.js` (datatables)
- `routes/knowledgeBases/cloudAccess.js`
  - line 48 -> `core/dataEngine/sources/spreadsheetFile/linkBrowse.js` (datatables)
  - line 50 -> `core/dataEngine/sources/spreadsheetFile/providers/index.js` (datatables)
  - line 52 -> `auth/datatableAccess.js` (datatables)
- `routes/knowledgeBases/cloudBrowse.js`
  - line 43 -> `core/dataEngine/sources/spreadsheetFile/linkRelink.js` (datatables)
- `routes/knowledgeBases/detail.js`
  - line 335 -> `stores/datatableStore.js` (datatables)
- `routes/knowledgeBases/n8n.js`
  - line 82 -> `integrations/n8nTools.js` (int_saas)
- `routes/knowledgeBases/queryLog.js`
  - line 49 -> `compliance/kbQueryLogEvidence.js` (compliance)
- `routes/knowledgeBases/queryLogNotice.js`
  - line 31 -> `stores/dpiaStore.js` (compliance)
- `routes/knowledgeBases/sourceCreate.js`
  - line 163 -> `stores/transcriptionStore.js` (meetingNotes)
  - line 203 -> `core/automationRunner/datatableResolve.js` (datatables)
  - line 217 -> `core/kb/sources/datatable.js` (datatables)
  - line 236 -> `core/kb/sources/datatable.js` (datatables)
- `routes/knowledgeBases/sources.js`
  - line 258 -> `core/automationRunner/datatableResolve.js` (datatables)
  - line 266 -> `core/kb/sources/datatable.js` (datatables)

## Core test files that fail with every module hidden (22)

- `core/documents/documentDiscovery.test.js`
- `core/documents/sheetImport.test.js`
- `core/integrations/outlookMailbox.test.js`
- `core/kb/kbUsage.test.js`
- `core/kb/queryLog/channels.pg.test.js`
- `core/kb/queryLog/searchCallSites.inventory.test.js`
- `core/kb/sources/cloudFolder.test.js`
- `core/kb/sources/keepOriginals.test.js`
- `core/kb/sources/meetingTag.test.js`
- `core/kb/sources/syncSource.characterisation.test.js`
- `core/kb/sources/syncSource.test.js`
- `jobs/kbSourceRefresh.liveDatatable.test.js`
- `jobs/kbSourceRefresh.meetingTap.test.js`
- `routes/knowledgeBases.projection.test.js`
- `routes/knowledgeBases.ssrf.test.js`
- `routes/knowledgeBases.wrappers.test.js`
- `routes/knowledgeBases/ask.test.js`
- `routes/knowledgeBases/cloudBrowse.validation.test.js`
- `routes/knowledgeBases/detail.k5.test.js`
- `routes/knowledgeBases/queryLog.test.js`
- `routes/knowledgeBases/sources.test.js`
- `routes/knowledgeBases/usage.test.js`
