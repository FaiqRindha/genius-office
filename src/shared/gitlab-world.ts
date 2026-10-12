// The GitLab world: every project on a self-hosted GitLab, standing in the city without anyone
// adding it. A top-level group is a district, the group a project is directly in (a subgroup at any
// depth, or the top-level group itself) is a building in that district, and the project is a floor
// of it. Projects are known by their GitLab id, so a rename or a move to another group keeps the
// floor (and moves it with the project). Districts and buildings keep the slot they were first
// given, so nothing already standing moves when a project comes or goes. Pure: the server keeps it
// up to date (see server/gitlab-world.ts) and the page draws it.
import { PER_CELL } from './gitlab-quarter.js';

/** A project on the GitLab, as the world needs it. */
export interface WorldProject {
  id: number;
  /** group/subgroup/project */
  path: string;
  name: string;
  /** The group (or user) it's directly in: group/subgroup. */
  namespace: string;
  /** Its namespace is a user's, not a group's: someone's personal project. */
  personal?: boolean;
  archived: boolean;
  webUrl: string;
}

export interface WorldFloor {
  projectId: number;
  name: string;
  path: string;
  archived: boolean;
  /** Which floor of its building it is, from the bottom (0): its own for good, opened or not. */
  level: number;
}

export interface WorldBuilding {
  /** The namespace it's for: group/subgroup. */
  key: string;
  /** What its sign says: "genius HQ" for a top-level group's own, else the rest of the path ("lab › ml"). */
  name: string;
  /** Its place in its district, kept for good. */
  slot: number;
  /** Oldest project first (lowest id): a new one is a new floor on top. */
  floors: WorldFloor[];
}

export interface WorldDistrict {
  /** The top-level group, or PERSONAL for everyone's own projects. */
  key: string;
  name: string;
  slot: number;
  /** The Quarter's cells it stands in (see gitlab-quarter.ts): its first, and more as it outgrows them. */
  cells: number[];
  buildings: WorldBuilding[];
}

/** Where districts and buildings stand: kept, so they don't move (see arrange). */
export interface WorldSlots {
  districts: Record<string, number>;
  /** By building key. */
  buildings: Record<string, number>;
  /** The Quarter's cells, by "<district>#<n>": a district's nth cell. */
  cells?: Record<string, number>;
  /** Each project's floor in its building, by "<building>#<project id>" (a move to another building is a new floor there). */
  levels?: Record<string, number>;
}

export interface WorldState {
  /** The GitLab it's of: https://gitlab.example.com */
  url: string;
  districts: WorldDistrict[];
  /** How many projects it has, and when it was last looked at. */
  projects: number;
  syncedAt: number;
  error?: string;
}

/** The district for everyone's personal projects (user namespaces), one building a person. */
export const PERSONAL = '@personal';

/** The district and building a project stands in. */
/** How many storeys building `b` has: up to its top project's, empty ones (projects gone since) and all. */
export function storeysOf(b: Pick<WorldBuilding, 'floors'>): number {
  return b.floors.reduce((top, f) => Math.max(top, f.level + 1), 0);
}

export function placeOf(p: Pick<WorldProject, 'namespace' | 'personal'>): { district: string; building: string } {
  if (p.personal) return { district: PERSONAL, building: p.namespace };
  return { district: p.namespace.split('/')[0], building: p.namespace };
}

/** The sign over a building's door. */
export function buildingName(key: string, district: string): string {
  if (district === PERSONAL) return `${key}'s projects`;
  const rest = key.split('/').slice(1);
  return rest.length ? rest.join(' › ') : `${key} HQ`;
}


/** The smallest slot number nobody in `taken` has. */
function freeSlot(taken: Set<number>): number {
  let n = 0;
  while (taken.has(n)) n++;
  return n;
}

/**
 * Arranges `projects` into districts, buildings and floors, keeping every district and building
 * that still stands where `slots` had it; new ones take the first free slot. A building is only
 * there while it has a project that isn't archived (its archived ones are floors of it, marked);
 * a district only while it has a building. Returns the arrangement and the slots to keep.
 */
export function arrange(projects: readonly WorldProject[], slots: WorldSlots = { districts: {}, buildings: {} }): { districts: WorldDistrict[]; slots: WorldSlots } {
  const placed = place(projects, slots);
  // Each district's cells: the ones it had stay its own, and one it needs now takes the first free.
  const cells: Record<string, number> = {};
  const need = placed.districts.flatMap((d) => Array.from({ length: Math.floor(Math.max(-1, ...d.buildings.map((b) => b.slot)) / PER_CELL) + 1 }, (_, n) => `${d.key}#${n}`));
  const taken = new Set<number>();
  for (const k of need) if (slots.cells?.[k] !== undefined && !taken.has(slots.cells[k])) taken.add((cells[k] = slots.cells[k]));
  // In district order, then their cells in order: a district's first cell before anyone's second.
  for (const k of [...need].sort((a, b) => Number(a.split('#').pop()) - Number(b.split('#').pop()) || placed.slots.districts[a.slice(0, a.lastIndexOf('#'))] - placed.slots.districts[b.slice(0, b.lastIndexOf('#'))])) {
    if (cells[k] === undefined) taken.add((cells[k] = freeSlot(taken)));
  }
  const districts = placed.districts.map((d) => ({ ...d, cells: need.filter((k) => k.startsWith(`${d.key}#`) && k.lastIndexOf('#') === d.key.length).map((k) => cells[k]) }));
  return { districts, slots: { ...placed.slots, cells } };
}

function place(projects: readonly WorldProject[], slots: WorldSlots): { districts: Omit<WorldDistrict, 'cells'>[]; slots: WorldSlots } {
  const byBuilding = new Map<string, { district: string; projects: WorldProject[] }>();
  for (const p of projects) {
    const { district, building } = placeOf(p);
    const b = byBuilding.get(building) ?? { district, projects: [] };
    b.projects.push(p);
    byBuilding.set(building, b);
  }
  for (const [key, b] of byBuilding) if (b.projects.every((p) => p.archived)) byBuilding.delete(key);

  const districtKeys = [...new Set([...byBuilding.values()].map((b) => b.district))];
  const next: WorldSlots = { districts: {}, buildings: {} };
  // The ones already standing keep their slots, then the new ones fill in, in name order (so two
  // offices arranging the same GitLab from nothing agree).
  const taken = new Set<number>();
  for (const d of districtKeys) if (slots.districts[d] !== undefined && !taken.has(slots.districts[d])) taken.add((next.districts[d] = slots.districts[d]));
  for (const d of districtKeys.sort()) if (next.districts[d] === undefined) taken.add((next.districts[d] = freeSlot(taken)));

  const districts: Omit<WorldDistrict, 'cells'>[] = districtKeys.map((d) => {
    const keys = [...byBuilding].filter(([, b]) => b.district === d).map(([k]) => k);
    const used = new Set<number>();
    for (const k of keys) if (slots.buildings[k] !== undefined && !used.has(slots.buildings[k])) used.add((next.buildings[k] = slots.buildings[k]));
    for (const k of keys.sort()) if (next.buildings[k] === undefined) used.add((next.buildings[k] = freeSlot(used)));
    const buildings = keys.map((k) => {
      // Each project keeps the floor it was given; a new one takes the lowest free floor, oldest first.
      const projects = byBuilding.get(k)!.projects.sort((a, b) => a.id - b.id);
      const used = new Set<number>();
      const level = new Map<number, number>();
      for (const p of projects) {
        const was = slots.levels?.[`${k}#${p.id}`];
        if (was !== undefined && !used.has(was)) used.add(was), level.set(p.id, was);
      }
      for (const p of projects) if (!level.has(p.id)) used.add(level.set(p.id, freeSlot(used)).get(p.id)!);
      (next.levels ??= {});
      for (const p of projects) next.levels[`${k}#${p.id}`] = level.get(p.id)!;
      return {
        key: k,
        name: buildingName(k, d),
        slot: next.buildings[k],
        floors: projects.map((p) => ({ projectId: p.id, name: p.name, path: p.path, archived: p.archived, level: level.get(p.id)! })).sort((a, b) => a.level - b.level),
      };
    });
    return { key: d, name: d === PERSONAL ? 'Personal projects' : d, slot: next.districts[d], buildings: buildings.sort((a, b) => a.slot - b.slot) };
  });
  return { districts: districts.sort((a, b) => a.slot - b.slot), slots: next };
}
