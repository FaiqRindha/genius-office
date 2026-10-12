import { buildingAt, isOutdoors } from '../../../shared/campus';
import { STOREY } from '../../../shared/layout';
import type { PeerInfo } from '../../../shared/protocol';
import { ROOF } from '../../../shared/rooftop';
import { store } from '../../state';

// Where things are in the campus's one world: each building where it stands, and the floor you're on
// built where it always is, round the middle of the one you're in (see shared/campus.ts).

/**
 * Where a building that isn't the campus's own stands, if `id` is one: another feature's buildings
 * (the GitLab Quarter's, see features/gitlab-world), added with `addPlace`.
 */
const places: ((id: string) => { x: number; z: number } | undefined)[] = [];

/** Has `where` say where the buildings it knows stand (see standsAt). */
export function addPlace(where: (id: string) => { x: number; z: number } | undefined) {
  places.push(where);
}

/** Where building `id` stands in the world (see buildingAt, and addPlace). */
export function standsAt(id: string): { x: number; z: number } {
  for (const where of places) {
    const at = where(id);
    if (at) return at;
  }
  return buildingAt(Math.max(0, store.campus.buildings.findIndex((b) => b.id === id)));
}

/** How far up its building floor `id` is (0, the bottom one, when it's not known). */
export const levelOf = (id: string | null | undefined) => (id ? (store.campus.floors?.[id]?.[1] ?? 0) : 0);

/**
 * Where someone not on your floor stands on its map, if they're out on the grounds (the street, the
 * steps, the district): everyone on the campus sees them there. Null when they're indoors somewhere,
 * up on the roof, or nowhere you know of.
 */
export function outdoorAt(peer: PeerInfo): { x: number; y: number; z: number; rotY: number } | null {
  const at = peer.floor && peer.floor !== ROOF ? store.campus.floors?.[peer.floor] : undefined;
  if (!at || store.floor === ROOF || !isOutdoors(peer.x, peer.y, peer.z)) return null;
  const theirs = standsAt(at[0]);
  const mine = standsAt(store.campus.here);
  // Their floor's map is theirs, as far up as their floor is: down to the street, and over to where you are.
  const y = peer.y + (at[1] - levelOf(store.floor)) * STOREY;
  return { x: peer.x + theirs.x - mine.x, y, z: peer.z + theirs.z - mine.z, rotY: peer.rotY };
}
