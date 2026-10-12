import { EXIT_DOOR, EXIT_STAIRS, FLOOR, ROAD, SLAB, WALL_T, WING, wingMinZ } from './layout.js';

// Where the campus's buildings stand, in one world everyone shares. The office's own building is on
// the main street, where the office has always been (0, 0); every account's stands in the district
// north of it, in rows five across, in the order the campus lists them. Every building is the
// office's tower over its garage, with its exit door and the steps down from it on the west side and
// an ID card reader at their foot. Inside one, its floor is built where it always is (around 0, 0) and
// the rest of the world is drawn that far away (see features/campus): wherever you are, the city is
// laid out the same.

/** A building's footprint, walls included, about its middle. */
export const FOOTPRINT = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;

/** Five slots to a row, 64 m apart; the first row's 90 m north of the office, each next one 62 m further. */
export const DISTRICT = { cols: 5, pitchX: 64, firstZ: -90, pitchZ: 62 } as const;

/** The avenue in front of each row (its middle, south of the row's buildings) and how wide it is. */
export const AVENUE = { ahead: FOOTPRINT.maxZ + 6, width: 8 } as const;

/** The boulevard up from the street to the district, clear of the office's neighbours on that side. */
export const BOULEVARD = { x: -36, width: 6, fromZ: ROAD.minZ - 2 } as const;

/** Where district slot `i` stands: the middle of its building, on the street. */
export function slotAt(i: number): { x: number; z: number } {
  const col = i % DISTRICT.cols;
  const row = Math.floor(i / DISTRICT.cols);
  return { x: (col - (DISTRICT.cols - 1) / 2) * DISTRICT.pitchX, z: DISTRICT.firstZ - row * DISTRICT.pitchZ };
}

/** Where the campus's building `i` stands: the office's own (0) on the main street, the rest in the district. */
export function buildingAt(i: number): { x: number; z: number } {
  return i <= 0 ? { x: 0, z: 0 } : slotAt(i - 1);
}

/** How far north the district goes for `n` buildings (the office's own included): the back of its last row. */
export function districtEnd(n: number): number {
  return slotAt(Math.max(0, n - 2)).z + FOOTPRINT.minZ - 8;
}

/** Every building's ID card reader, from the middle of the building: on a post at the foot of its exit steps. */
export const READER = { x: EXIT_STAIRS.minX - 0.55, z: EXIT_STAIRS.landingZ1 + 3.2 } as const;

/** A building's exit door from the middle of the building, on the landing at the top of its steps: walk through it, and you're in. */
export const DOOR = { x: FLOOR.minX - WALL_T / 2, z: EXIT_DOOR.u } as const;

/** Where you come in through a building's door: just inside it, facing into the room. */
export const ENTRY = { x: FLOOR.minX + 1.4, y: 0, z: EXIT_DOOR.u, rotY: Math.PI / 2 } as const;

/** How close you have to be to a reader for it to take your card (the server checks it too). */
export const TAP_REACH = 2.2;

/**
 * Whether someone at (x, y, z) on a floor's own map is out on the grounds (the street, the steps, the
 * balcony, the garage) rather than in the building: there, everyone on the campus can see them.
 */
export function isOutdoors(x: number, y: number, z: number): boolean {
  const inside = x > FLOOR.minX && x < FLOOR.maxX && z < FLOOR.maxZ && (z > FLOOR.minZ || (x > WING.minX && z > wingMinZ(WING.rows)));
  return !inside || y < -SLAB - 0.7 || y > 12;
}
