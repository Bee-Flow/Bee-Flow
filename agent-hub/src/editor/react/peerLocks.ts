/** Co-editing guard for the section drag layer. */
import type { CollabPeer } from '../collab/useCollab';
import type { ModelPos } from '../engine/textIndex';

interface PositionSource { relToPos(b64: string): ModelPos | null }

/**
 * Whether a co-editor's caret sits inside top-level blocks [from, from+count):
 * moving that part would delete and re-insert it under their fingers.
 */
export function peerInBlocks(binding: PositionSource | null, peers: CollabPeer[] | null | undefined, from: number, count: number): boolean {
  if (!binding || !peers?.length) return false;
  for (const p of peers) {
    if (!p.cursor) continue;
    const at = binding.relToPos(p.cursor.head);
    if (at && at.path[0] >= from && at.path[0] < from + count) return true;
  }
  return false;
}
