/**
 * The building's floors as the office and its parts see them: which are built, how far each one's
 * back office goes, and which seats are there to sit at.
 */
import { DESK_BY_ID, FLOOR, WING, deskBuilt, inWing } from '../../shared/layout';
import type { FloorInfo } from '../../shared/protocol';
import { store } from '../state';

/**
 * Which storey of its building floor `f` is, from the bottom (0): where the campus puts it (a GitLab
 * project's floor is always the same one, opened or not: see server/campus.ts), else `i`, its place in the list.
 */
export function storeyOf(f: FloorInfo, i: number): number {
  return store.campus.floors?.[f.id]?.[1] ?? i;
}

/** `floors` from the bottom storey up (see storeyOf). */
export function byStorey(floors: FloorInfo[]): FloorInfo[] {
  return floors
    .map((f, i) => ({ f, at: storeyOf(f, i) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.f);
}

/** The floors of the building from the bottom up (not the ones still being cloned: nobody can go there yet). */
export function builtFloors(): FloorInfo[] {
  return byStorey(store.floors.filter((f) => !f.cloning));
}

/** The storey `floors` (builtFloors) has each of them on, by id. */
export function storeys(floors: FloorInfo[]): Map<string, number> {
  return new Map(floors.map((f, i) => [f.id, storeyOf(f, i)]));
}

/** How far each storey's back office goes, for the building's outside (the one you're on as you see it); none on an empty one. */
export function floorWings(floors: FloorInfo[]): number[] {
  const at = storeys(floors);
  const wings: number[] = [];
  for (const f of floors) wings[at.get(f.id)!] = f.id === store.floor ? store.floorPlan.wing : (f.wing ?? 0);
  return Array.from(wings, (w) => w ?? 0);
}

/**
 * Whether seat `id` is there to sit at on this floor: a back office desk only once the floor's built
 * out that far, on whichever map (the castle names seats for them too, so a worker hired there has
 * one on every map).
 */
export function seatBuilt(id: string): boolean {
  const d = DESK_BY_ID.get(id);
  return !d || deskBuilt(d, store.floorPlan.wing);
}

/**
 * Standing where a back office would be, further back than this floor's goes (`level` rows): a row
 * walled up round you, or a floor you switched to that isn't built out as far as the one you left.
 */
export function pastTheWing(p: { x: number; y: number; z: number }, level: number): boolean {
  return p.y > -1 && p.y < 3 && p.x > WING.minX - 0.3 && p.x < WING.maxX + 0.3 && p.z < FLOOR.minZ && !inWing(p.x, p.z, level);
}

/** How many floors the building you're in shows besides the ones built (see addBuildingHeight). */
const heights: (() => number)[] = [];

/**
 * Has the building you're in drawn at least as tall as `floors()` says (a GitLab building is as tall
 * as it has projects, opened or not: see features/gitlab-world), however many of its floors are built.
 */
export function addBuildingHeight(floors: () => number) {
  heights.push(floors);
}

/** How tall the building you're in is drawn: its `built` floors, or more if something says so. */
export function shownHeight(built: number): number {
  return Math.max(built, ...heights.map((f) => f()));
}
