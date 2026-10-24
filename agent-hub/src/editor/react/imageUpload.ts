/** Image upload: the default notebook uploader and the check on the address an uploader returns. */
import { API_BASE } from '../../utils/helpers';
import { mutate, ApiError } from '../../api/mutate';

/** An uploaded image's address the editor will embed: same-origin or http(s). */
// A picture carried inside the document (a page embeds its images, since the
// PDF renderer fetches nothing): raster types only, and about 300 KB of image
// at most, which is roughly 410 KB of base64.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_DATA_IMAGE_CHARS = 410 * 1024;

export function isSafeImageSrc(src: unknown): boolean {
  const s = typeof src === 'string' ? src : '';
  if (!s) return false;
  if (s.startsWith('/') || /^https?:\/\//i.test(s)) return true;
  return s.length <= MAX_DATA_IMAGE_CHARS && DATA_IMAGE.test(s);
}

/** The notebook image endpoint (the default uploader when a notebookId is set). */
export async function uploadNotebookImage(nbId: string | number, file: File): Promise<{ src: string; alt: string } | null> {
  const fd = new FormData();
  fd.append('image', file);
  // authFetch, not the global fetch: the bare call bypassed the demo-mode
  // transport, so an image paste inside a public feature demo escaped the
  // fixture layer and hit the real API unauthenticated.
  let res: Response;
  try {
      res = await mutate(`${API_BASE}/api/notebooks/${encodeURIComponent(nbId)}/images`, { method: 'POST', body: fd, credentials: 'include' });
  } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      throw new Error(`upload ${err.status}`);
  }
  const data = await res.json();
  return data?.url ? { src: `${API_BASE}${data.url}`, alt: file.name } : null;
}
