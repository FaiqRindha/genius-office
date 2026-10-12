import { EXIT_DOOR, EXIT_STAIRS, FLOOR, ROAD, WALL_T } from './layout.js';

// Where the campus's buildings stand. The one you're in is always the office in the middle of the map,
// on the street; every other one stands in the district north of it, in rows five across, each in the
// slot the campus's list gives it (see CampusState.buildings), so they're always in the same places
// whichever one you're in. Yours has a plaza in its slot. A boulevard runs up from the street, past
// the office's west side, to the avenue in front of each row.

/** A building's footprint, walls included, about its middle. */
export const FOOTPRINT = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;

/** Five slots to a row, 64 m apart; the first row's 90 m north of the office, each next one 62 m further. */
export const DISTRICT = { cols: 5, pitchX: 64, firstZ: -90, pitchZ: 62 } as const;

/** The avenue in front of each row (its middle, south of the row's buildings) and how wide it is. */
export const AVENUE = { ahead: FOOTPRINT.maxZ + 6, width: 8 } as const;

/** The boulevard up from the street to the district, clear of the office's neighbours on that side. */
export const BOULEVARD = { x: -36, width: 6, fromZ: ROAD.minZ - 2 } as const;

/** Where slot `i` stands: the middle of its building, on the street. */
export function slotAt(i: number): { x: number; z: number } {
  const col = i % DISTRICT.cols;
  const row = Math.floor(i / DISTRICT.cols);
  return { x: (col - (DISTRICT.cols - 1) / 2) * DISTRICT.pitchX, z: DISTRICT.firstZ - row * DISTRICT.pitchZ };
}

/** How far north the district goes for `n` buildings: the back of its last row. */
export function districtEnd(n: number): number {
  return slotAt(Math.max(0, n - 1)).z + FOOTPRINT.minZ - 8;
}

/**
 * The card reader by a district building's door, from the middle of the building: on a post on the
 * pavement, in front of its glass doors at the west end of its front.
 */
export const READER = { x: FOOTPRINT.minX + 3.2, z: FOOTPRINT.maxZ + 1.1 } as const;
/** Its glass doors, in the front wall at street level: their middle (x), and how wide. */
export const ENTRANCE = { x: FOOTPRINT.minX + 5.5, width: 3 } as const;

/** The office's own reader, at the foot of the steps down from its exit door (it opens the door from outside). */
export const HOME_READER = { x: EXIT_STAIRS.minX - 0.55, z: EXIT_STAIRS.landingZ1 + 3.2 } as const;

/** Where your card lets you in: just inside the bottom floor's exit door, facing into the room. */
export const ENTRY = { x: FLOOR.minX + 1.4, y: 0, z: EXIT_DOOR.u, rotY: Math.PI / 2 } as const;

/** How close you have to be to a reader for it to take your card (the server checks it too). */
export const TAP_REACH = 2.2;
