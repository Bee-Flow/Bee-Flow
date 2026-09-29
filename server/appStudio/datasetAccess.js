/**
 * Whose a LARGE dataset is: the one rule the upload router
 * (routes/studioAppDatasets.js) and the two query paths (the dataset_query
 * step and the AI steps' query_genome_dataset tool, both through
 * datasetQueryStep.resolveReadyDataset) share, so they cannot drift.
 *
 * A large dataset is a person's genome file, and it is the person's who
 * uploaded it. The app's owner lends the storage (the manifest and the bytes
 * sit in the owner's envelope, and count against the owner's quota), but that
 * does not make the file theirs to read: genetic data is special-category
 * data (GDPR art. 9), and nothing in the app asks a member to share it with
 * the author, or with the colleague next to them. So only the uploader lists,
 * polls, continues, completes or queries it. The owner may delete it, which
 * frees their storage without reading a byte (routes/studioAppDatasets.js).
 *
 * There is no "shared dataset" yet, not even for the owner's own uploads: an
 * owner who publishes their personal genome app to the organisation must not
 * hand every member their variants. Sharing reference data would need an
 * explicit choice by the uploader, per dataset, and that does not exist.
 */

'use strict';

/**
 * True only for the person who uploaded `ds`. Ids compare as text: the
 * manifest column is TEXT, and a caller that names nobody (a missing viewer)
 * is nobody's uploader.
 */
function isUploaderOf(ds, userId) {
    if (!ds || ds.uploaderId == null || userId == null || userId === '') return false;
    return String(ds.uploaderId) === String(userId);
}

module.exports = { isUploaderOf };
