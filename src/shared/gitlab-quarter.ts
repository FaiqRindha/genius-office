// Where the GitLab world stands (see gitlab-world.ts): the GitLab Quarter, north of the town past the
// campus's district, beyond the meadow. It's a grid of cells, five across, each a block of buildings
// three across and two deep; a district takes a cell, and another when it has more buildings than one
// holds. Each building's plot is a whole office building's (its floors, when you're inside one, stand
// there, over its own garage with its cars), and each row of plots has a road along its front, so
// every garage drives out onto one. Metres, +y up, north is -z (see layout.ts). Pure: the page draws
// it, cars drive it (see paved in garage.ts), and the trees keep out of it.
import { FLOOR, ROAD, WALL_T } from './layout.js';

export const QUARTER = {
  /** Its front avenue, along the south edge of its first row of cells. */
  z: -300,
  /** The west edge of its first column: clear of the beach (the shore's at x ≈ -254, see shoreX). */
  x: -205,
  cols: 5,
  cellW: 150,
  /** Two rows of plots, a road along the front of each, and a little room behind each. */
  cellD: 92,
  /** As far north as the ground goes (see REACH in world/outside.ts). */
  minZ: -880,
};

/**
 * A cell's plots: three across and two deep, front row first. A plot is a whole office building's:
 * from its card reader on the west (x -20.5) to its east wall (18.3), and from its wing at the back
 * (z -22.2) to the foot of its exit steps at the front (13.3), so 46 m apart leaves room between.
 */
export const BLOCK = { cols: 3, rows: 2, pitchX: 46, pitchZ: 46 };
export const PER_CELL = BLOCK.cols * BLOCK.rows;
const ROWS = Math.floor((QUARTER.z - QUARTER.minZ) / QUARTER.cellD);
/** How many cells fit between the front avenue and the far edge of the ground: 180 buildings. */
export const CELLS = QUARTER.cols * ROWS;
/** How wide the Quarter's streets and avenues are. */
export const STREET_W = 8;
/** From a plot's middle to the road along its front: its garage opens onto it. */
const FRONT = FLOOR.maxZ + WALL_T + 0.5;

/** The middle of cell `c`. */
export function cellAt(c: number): { x: number; z: number } {
  const col = c % QUARTER.cols;
  const row = Math.floor(c / QUARTER.cols);
  return { x: QUARTER.x + QUARTER.cellW / 2 + col * QUARTER.cellW, z: QUARTER.z - QUARTER.cellD / 2 - row * QUARTER.cellD };
}

/** Cell `c`'s south edge: the avenue along its front. */
export function frontOf(c: number): number {
  return QUARTER.z - Math.floor(c / QUARTER.cols) * QUARTER.cellD;
}

/**
 * Where building slot `slot` of a district stands, given its cells: the middle of its plot, which is
 * where its office floors stand when you're inside it (the floor's own middle, see Grounds).
 */
export function plotAt(cells: readonly number[], slot: number): { x: number; z: number } | undefined {
  const cell = cells[Math.floor(slot / PER_CELL)];
  // Off the edge of the world: not put up (a GitLab that big needs more ground first).
  if (cell === undefined || cell >= CELLS) return undefined;
  const c = cellAt(cell);
  const i = slot % PER_CELL;
  const row = Math.floor(i / BLOCK.cols);
  return { x: c.x + ((i % BLOCK.cols) - (BLOCK.cols - 1) / 2) * BLOCK.pitchX, z: frontOf(cell) - STREET_W / 2 - FRONT - row * BLOCK.pitchZ };
}

/**
 * The road up from the main street to the Quarter's front avenue: off the street west of the office,
 * between the neighbours' houses (the one at x -48 reaches -39.8, the one at -20 starts at -29.2) and
 * past the street lamp at -40, then north through the meadow.
 */
export const QUARTER_PATH = { x: -34, width: 8, fromZ: ROAD.maxZ };

/** A stretch of road: an axis-aligned box on the ground, metres. */
export interface RoadBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const EAST = QUARTER.x + QUARTER.cols * QUARTER.cellW;
const BACK = QUARTER.z - ROWS * QUARTER.cellD;
const across = (z: number): RoadBox => ({ minX: QUARTER.x - STREET_W / 2, maxX: EAST + STREET_W / 2, minZ: z - STREET_W / 2, maxZ: z + STREET_W / 2 });

/**
 * Every road of the Quarter, which cars can drive (see paved in garage.ts) and the page draws: the
 * road up from the main street; an avenue along each edge of each row of cells (the front one first),
 * which its front row's garages open onto; a street through the middle of each cell, which its back
 * row's open onto; and a street down each side of each column. They meet, so every garage is a drive
 * away. The whole grid is there however many districts there are, so a new one has its roads already.
 */
export const QUARTER_ROADS: readonly RoadBox[] = [
  { minX: QUARTER_PATH.x - QUARTER_PATH.width / 2, maxX: QUARTER_PATH.x + QUARTER_PATH.width / 2, minZ: QUARTER.z, maxZ: QUARTER_PATH.fromZ },
  ...Array.from({ length: ROWS + 1 }, (_, r) => across(QUARTER.z - r * QUARTER.cellD)),
  ...Array.from({ length: ROWS }, (_, r) => across(QUARTER.z - r * QUARTER.cellD - BLOCK.pitchZ)),
  ...Array.from({ length: QUARTER.cols + 1 }, (_, c) => {
    const x = QUARTER.x + c * QUARTER.cellW;
    return { minX: x - STREET_W / 2, maxX: x + STREET_W / 2, minZ: BACK - STREET_W / 2, maxZ: QUARTER.z };
  }),
];

/** Each plot's garage, under its building, and out to the road along its front (paved, not drawn as road). */
export const QUARTER_GARAGES: readonly RoadBox[] = Array.from({ length: CELLS * PER_CELL }, (_, i) => {
  const at = plotAt([Math.floor(i / PER_CELL)], i % PER_CELL)!;
  return { minX: at.x + FLOOR.minX, maxX: at.x + FLOOR.maxX + WALL_T, minZ: at.z + FLOOR.minZ, maxZ: at.z + FRONT + 1 };
});

const inside = (b: RoadBox, x: number, z: number) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

/** Whether (x, z) is on one of the Quarter's roads, or a plot's garage: somewhere a car can go. */
export function onQuarterRoad(x: number, z: number): boolean {
  // Nowhere near the Quarter (the town, the loop): nothing to look through.
  if (z > QUARTER_PATH.fromZ || x < QUARTER.x - STREET_W || x > EAST + STREET_W) return false;
  return QUARTER_ROADS.some((b) => inside(b, x, z)) || (z <= QUARTER.z && QUARTER_GARAGES.some((b) => inside(b, x, z)));
}

/** Whether (x, z) is the Quarter or the road up to it (the meadow's trees keep out). */
export function inQuarter(x: number, z: number): boolean {
  if (x >= QUARTER.x - 10 && x <= EAST + 10 && z <= QUARTER.z + 14 && z >= QUARTER.minZ) return true;
  return Math.abs(x - QUARTER_PATH.x) <= QUARTER_PATH.width && z <= QUARTER_PATH.fromZ && z >= QUARTER.z;
}
