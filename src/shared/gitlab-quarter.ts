// Where the GitLab world stands (see gitlab-world.ts): the GitLab Quarter, north of the town past the
// campus's district, beyond the meadow. It's a grid of cells, five across, each a block of four by
// four buildings; a district takes a cell, and another when it has more buildings than one holds.
// Metres, +y up, north is -z (see layout.ts). Pure: the page draws it, and the trees keep out of it.
import { ROAD } from './layout.js';

export const QUARTER = {
  /** Its front avenue, along the south edge of its first row of cells. */
  z: -300,
  /** The west edge of its first column: clear of the beach (the shore's at x ≈ -254, see shoreX). */
  x: -205,
  cols: 5,
  cellW: 150,
  cellD: 144,
  /** As far north as the ground goes (see REACH in world/outside.ts). */
  minZ: -880,
};

/** A cell's buildings: four across and four deep, front row first. */
export const BLOCK = { cols: 4, rows: 4, pitchX: 34, pitchZ: 34 };
export const PER_CELL = BLOCK.cols * BLOCK.rows;
/** How many cells fit between the front avenue and the far edge of the ground: 320 buildings. */
export const CELLS = QUARTER.cols * Math.floor((QUARTER.z - QUARTER.minZ) / QUARTER.cellD);

/** The middle of cell `c`. */
export function cellAt(c: number): { x: number; z: number } {
  const col = c % QUARTER.cols;
  const row = Math.floor(c / QUARTER.cols);
  return { x: QUARTER.x + QUARTER.cellW / 2 + col * QUARTER.cellW, z: QUARTER.z - QUARTER.cellD / 2 - row * QUARTER.cellD };
}

/** Where building slot `slot` of a district stands, given its cells: the middle of its plot. */
export function plotAt(cells: readonly number[], slot: number): { x: number; z: number } | undefined {
  const cell = cells[Math.floor(slot / PER_CELL)];
  // Off the edge of the world: not put up (a GitLab that big needs more ground first).
  if (cell === undefined || cell >= CELLS) return undefined;
  const c = cellAt(cell);
  const i = slot % PER_CELL;
  return { x: c.x - ((BLOCK.cols - 1) / 2) * BLOCK.pitchX + (i % BLOCK.cols) * BLOCK.pitchX, z: c.z + ((BLOCK.rows - 1) / 2) * BLOCK.pitchZ - Math.floor(i / BLOCK.cols) * BLOCK.pitchZ };
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

/** How wide the Quarter's streets and avenues are. */
export const STREET_W = 8;
const ROWS = Math.floor((QUARTER.z - QUARTER.minZ) / QUARTER.cellD);
const EAST = QUARTER.x + QUARTER.cols * QUARTER.cellW;
const BACK = QUARTER.z - ROWS * QUARTER.cellD;

/**
 * Every road of the Quarter, which cars can drive on (see paved in garage.ts) and the page draws: the
 * road up from the main street, the front avenue, an avenue along the back of each row of
 * cells, and a street down each side of each column. They meet, so every district is a drive away.
 * The whole grid is there however many districts there are, so a new one has its roads already.
 */
export const QUARTER_ROADS: readonly RoadBox[] = [
  { minX: QUARTER_PATH.x - QUARTER_PATH.width / 2, maxX: QUARTER_PATH.x + QUARTER_PATH.width / 2, minZ: QUARTER.z, maxZ: QUARTER_PATH.fromZ },
  { minX: QUARTER.x - STREET_W / 2, maxX: EAST + STREET_W / 2, minZ: QUARTER.z - STREET_W / 2, maxZ: QUARTER.z + STREET_W / 2 },
  ...Array.from({ length: ROWS }, (_, r) => {
    const z = QUARTER.z - (r + 1) * QUARTER.cellD;
    return { minX: QUARTER.x - STREET_W / 2, maxX: EAST + STREET_W / 2, minZ: z - STREET_W / 2, maxZ: z + STREET_W / 2 };
  }),
  ...Array.from({ length: QUARTER.cols + 1 }, (_, c) => {
    const x = QUARTER.x + c * QUARTER.cellW;
    return { minX: x - STREET_W / 2, maxX: x + STREET_W / 2, minZ: BACK - STREET_W / 2, maxZ: QUARTER.z };
  }),
];

/** Whether (x, z) is on one of the Quarter's roads. */
export function onQuarterRoad(x: number, z: number): boolean {
  return QUARTER_ROADS.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
}

/** Whether (x, z) is the Quarter or the road up to it (the meadow's trees keep out). */
export function inQuarter(x: number, z: number): boolean {
  if (x >= QUARTER.x - 10 && x <= EAST + 10 && z <= QUARTER.z + 14 && z >= QUARTER.minZ) return true;
  return Math.abs(x - QUARTER_PATH.x) <= QUARTER_PATH.width && z <= QUARTER_PATH.fromZ && z >= QUARTER.z;
}
