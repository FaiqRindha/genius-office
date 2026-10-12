// How each building of the GitLab Quarter looks: its shape, colours, windows and roof, from its
// namespace (so it looks the same for everyone, every time), its height from how many projects it has.

export type Shape = 'block' | 'tower' | 'stepped' | 'podium' | 'twin';
export type Windows = 'bands' | 'grid' | 'curtain';
export type Roof = 'flat' | 'garden' | 'antenna' | 'helipad' | 'pitched' | 'dome';

export interface Style {
  shape: Shape;
  /** Its footprint, metres across (x) and deep (z). */
  w: number;
  d: number;
  /** How many storeys it shows (its projects, within reason), and how tall each is. */
  storeys: number;
  storeyH: number;
  facade: string;
  /** Its glass, and the trim round its windows, its cornice and its door. */
  glass: string;
  trim: string;
  windows: Windows;
  roof: Roof;
  /** Lights in its windows at night, warm or cool. */
  lit: string;
}

const FACADES = ['#e9d8a6', '#94d2bd', '#ee9b00', '#ca6702', '#bb3e03', '#0a9396', '#8ecae6', '#ffb703', '#cdb4db', '#a3b18a', '#f4a261', '#e76f51', '#d4a373', '#b8c0ff', '#ced4da'];
const GLASS = ['#1d3557', '#264653', '#3a506b', '#2b2d42', '#14213d', '#355070'];
const TRIM = ['#edf2f4', '#2b2d42', '#6c584c', '#adb5bd', '#fefae0'];
const LIT = ['#ffe8a3', '#fff3c4', '#cdeaff'];
const SHAPES: Shape[] = ['block', 'tower', 'stepped', 'podium', 'twin'];
const WINDOWS: Windows[] = ['bands', 'grid', 'curtain'];
const ROOFS: Roof[] = ['flat', 'garden', 'antenna', 'helipad', 'pitched', 'dome'];

/** The tallest a building shows, however many projects it has (its sign says how many). */
export const MAX_STOREYS = 24;

/** A number from `key` that's always the same for it (FNV-1a). */
export function hashOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Random numbers in [0, 1) from `seed`, the same ones every time (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];

/** The look of the building for namespace `key`, with `floors` projects. */
export function styleOf(key: string, floors: number): Style {
  const r = seeded(hashOf(key));
  const shape = pick(r, SHAPES);
  const storeys = Math.max(2, Math.min(MAX_STOREYS, floors + 1));
  // A tower's slender and tall-storeyed; a block's broad; the rest in between. A plot is 34 by 36.
  const [minW, maxW] = shape === 'tower' ? [11, 14] : shape === 'block' ? [20, 26] : [16, 22];
  const w = Math.round(minW + r() * (maxW - minW));
  const d = Math.round(minW + r() * (maxW - minW));
  let roof = pick(r, ROOFS);
  // A pitched roof or a dome sits on something broad enough to carry it.
  if ((roof === 'pitched' || roof === 'dome') && (shape === 'twin' || w < 14)) roof = 'flat';
  return {
    shape,
    w,
    d,
    storeys,
    storeyH: shape === 'tower' ? 4 : 3.5,
    facade: pick(r, FACADES),
    glass: pick(r, GLASS),
    trim: pick(r, TRIM),
    windows: pick(r, WINDOWS),
    roof,
    lit: pick(r, LIT),
  };
}
