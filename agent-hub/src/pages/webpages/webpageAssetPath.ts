const EXT_FOR_MIME: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf',
    'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf',
};

/**
 * Map an (possibly resize-converted) MIME type back to a file extension so the
 * stored asset path matches its bytes — the server derives MIME from the path.
 */
function extForMime(mime: string, name: string): string {
    if (EXT_FOR_MIME[mime]) return EXT_FOR_MIME[mime];
    const fromName = (name.split('.').pop() || '').toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : 'bin';
}

/**
 * A free path for an uploaded asset: `<folder>/<stem>.<ext>`, with `-1`, `-2`,
 * ... appended to the stem while the path is taken.
 */
export function uniqueAssetPath(fileName: string | undefined, mimeType: string, folder: string, taken: Set<string>): string {
    const ext = extForMime(mimeType, fileName || 'asset');
    const stem = (fileName || 'asset').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'asset';
    let path = `${folder}/${stem}.${ext}`;
    let n = 1;
    while (taken.has(path)) { path = `${folder}/${stem}-${n}.${ext}`; n++; }
    return path;
}
