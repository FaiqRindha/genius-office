import * as THREE from 'three';
import { CELLS, QUARTER, QUARTER_ROADS, STREET_W, cellAt, frontOf, plotAt } from '../../../shared/gitlab-quarter';
import { storeysOf, type WorldBuilding, type WorldDistrict, type WorldState } from '../../../shared/gitlab-world';
import { FOOTPRINT, READER } from '../../../shared/campus';
import { CAR, CARS } from '../../../shared/garage';
import { SLAB, STOREY, STREET_Y, WALL_HEIGHT } from '../../../shared/layout';
import { mergeByColor, mergeByMaterial, mesh, textPlane, toon } from '../../world/toon';
import { buildTower } from '../../world/tower';
import { buildGarage, type NightParts } from '../../world/outside';
import { buildExitStairs } from '../../world/office/balcony';
import { exitDoor } from '../../world/office/shell';
import { supercar } from '../cars/world';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';

// The GitLab Quarter: every project on the GitLab, standing north of the town (see
// shared/gitlab-quarter.ts for where, shared/gitlab-world.ts for what). A district is a block of
// buildings with its group's name on a sign on its corner; each building is its namespace, an office
// building like the one on the main street (its tower as tall as it has projects, over its garage
// with its cars, its steps up its west side and a card reader at their foot, where E takes you in),
// so it looks the same from outside as it does once you've been in and come out. Buildings out past
// the fog aren't drawn. Built in the street's world group, where it stands in the world, like the campus.

declare module '../../world/types' {
  interface OfficeHandles {
    gitlabWorld: GitLabQuarter;
  }
  interface Interactable {
    /** Which building of the GitLab Quarter a door is (its namespace: see WorldBuilding.key). */
    gitlabBuilding?: string;
  }
}

export interface GitLabQuarter {
  /** Puts up the world as `state` has it (none: takes it down). */
  set(state: WorldState | null): void;
  /**
   * Where the building you're in stands in the world (see standsAt): what's in the way moves round
   * it. `inside`: the Quarter building that is (its namespace), which isn't put up while you're in
   * it, since its floors stand there instead.
   */
  setHere(at: { x: number; z: number }, inside?: string): void;
  /** Each building's card reader, where it is on the floor you're on (E there to go in: see index.ts). */
  doors: Interactable[];
  /** You're at (x, z) in the world: only the buildings this side of the fog are drawn. */
  cull(at: { x: number; z: number }): void;
}

const G = STREET_Y;
const PAVE = '#c9c2b8';
const ASPHALT = '#5b606c';
const SIGN = { color: '#2b2d42', bg: '#fffaf3' } as const;
/** The tallest a building's drawn from outside, however many storeys it has (inside, it's as tall as it is). */
export const MAX_FLOORS = 100;
/** Past this far from you, a building isn't drawn (the fog's thick long before it). */
const DRAWN = 260;

/** A box `w` × `h` × `d` with its bottom at y, in `group`. */
function box(group: THREE.Object3D, color: string, w: number, h: number, d: number, x: number, y: number, z: number) {
  group.add(mesh(new THREE.BoxGeometry(w, h, d), toon(color), x, y + h / 2, z));
}

/** Text with no card behind it: no outline round its plane (the toon outline would draw a box). */
function bare(t: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>) {
  t.material.userData.outlineParameters = { visible: false };
  return t;
}

/** A district's sign, up on a post on its corner, its board out over the street beside it (clear of its buildings): its group's name, both ways along the avenue. */
function pylon(name: string, buildings: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(1.2, 11, 1.2), toon('#6c757d'), 0, 5.5, 0));
  g.add(mesh(new THREE.BoxGeometry(16, 3.4, 0.8), toon('#2b2d42'), -7, 11.6, 0));
  for (const back of [false, true]) {
    const t = bare(textPlane(`🦊 ${name}`, { size: 72, color: '#fffaf3' }));
    t.scale.setScalar(Math.min(4.5, 14.5 / (t.geometry.parameters.width || 1)));
    t.position.set(-7, 12.1, back ? -0.42 : 0.42);
    if (back) t.rotation.y = Math.PI;
    const sub = bare(textPlane(`${buildings} building${buildings === 1 ? '' : 's'}`, { size: 40, color: '#ffd6a5' }));
    sub.scale.setScalar(1.8);
    sub.position.set(-7, 10.6, back ? -0.42 : 0.42);
    if (back) sub.rotation.y = Math.PI;
    g.add(t, sub);
  }
  return g;
}

/** A card reader on its post, as the campus's are: E at it opens the building (see index.ts). */
function reader(): THREE.Group {
  const g = new THREE.Group();
  g.rotation.y = -Math.PI / 2;
  g.add(mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), toon('#8d99ae'), 0, 0.55, 0));
  g.add(mesh(new THREE.BoxGeometry(0.3, 0.42, 0.1), toon('#2b2d42'), 0, 1.25, 0.02));
  g.add(mesh(new THREE.BoxGeometry(0.18, 0.05, 0.02), toon('#fca311', { emissive: '#fca311' }), 0, 1.38, 0.08, false));
  return g;
}

/**
 * A building of the Quarter, its middle at (0, 0) on the floor's level (the street is at G below):
 * the office's own tower, as tall as it has projects, its roof, the garage under it with its cars
 * parked, the steps up its west side to its exit door, and its name on the front of its garage.
 * What's in the way of it is in `solid`, from its middle.
 */
export function officeBuilding(b: Pick<WorldBuilding, 'name' | 'floors'>, night: NightParts): { group: THREE.Group; solid: Collider[]; top: number } {
  const g = new THREE.Group();
  // As tall as its storeys, the same before you go in and after (see storeysOf).
  const floors = Math.max(1, Math.min(MAX_FLOORS, storeysOf(b)));
  const tower = buildTower([], night);
  // Every floor of it, from the bottom one up, and its roof on top (as the campus puts others up).
  tower.set(floors, floors);
  tower.group.position.y = floors * STOREY;
  g.add(tower.group);
  const w = FOOTPRINT.maxX - FOOTPRINT.minX;
  const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
  const top = (floors - 1) * STOREY + WALL_HEIGHT + SLAB;
  g.add(mesh(new THREE.BoxGeometry(w, SLAB, d), toon('#fffaf3'), 0, top - SLAB / 2, 0, false));
  const solid: Collider[] = [];
  const low = new THREE.Group();
  buildGarage(low, solid);
  low.add(mesh(new THREE.BoxGeometry(w, SLAB, d), toon('#c9ccd4'), 0, -SLAB / 2, 0, false));
  for (const def of CARS) {
    // The one left out front is the main street's own.
    if (def.z > FOOTPRINT.maxZ) continue;
    const car = supercar(def.kind, def.color).root;
    car.position.set(def.x, G, def.z);
    car.rotation.y = def.rotY;
    low.add(car);
    const along = Math.abs(Math.cos(def.rotY)) > 0.5;
    const [hx, hz] = along ? [CAR.width / 2, CAR.length / 2] : [CAR.length / 2, CAR.width / 2];
    solid.push({ minX: def.x - hx, maxX: def.x + hx, minZ: def.z - hz, maxZ: def.z + hz, bottom: G, top: G + CAR.roof });
  }
  buildExitStairs(low, solid);
  g.add(mergeByMaterial(low));
  // Its exit door, shut (you go in at the reader), lit as the campus's others are.
  g.add(exitDoor({ ...night, bulbs: [], halos: [], lamps: [] } as NightParts).group);
  const live = b.floors.filter((f) => !f.archived).length;
  const name = textPlane(`🦊 ${b.name} · ${live} project${live === 1 ? '' : 's'}`, { size: 64, ...SIGN });
  name.scale.setScalar(Math.min(3.4, 24 / (name.geometry.parameters.width || 1)));
  name.position.set(-4.8, G + 2.55, FOOTPRINT.maxZ + 0.06);
  g.add(name);
  // Under the whole of its floors, from its bottom one up to its roof.
  solid.push({ ...FOOTPRINT, bottom: -SLAB, top });
  return { group: g, solid, top };
}

/** Throws away what a group was built of (a tower's materials are its own, so they go too). */
function dispose(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((m) => {
    const x = m as THREE.Mesh;
    x.geometry?.dispose();
    const mat = x.material as THREE.MeshBasicMaterial | undefined;
    // Signs' textures and materials are their own; the toon ones are shared.
    if (mat && 'map' in mat && mat.map) {
      mat.map.dispose();
      mat.dispose();
    }
  });
}

export function buildQuarter(ground: THREE.Group, colliders: Collider[], night: NightParts) {
  const root = new THREE.Group();
  root.name = 'gitlab-quarter';
  ground.add(root);
  let built = '';
  let shown: WorldState | null = null;
  /** The Quarter building you're in, if you're in one: not put up (its floors are there instead). */
  let inside: string | undefined;
  let here = { x: 0, z: 0 };
  let drop = 0;
  let mine: { c: Collider; base: Collider }[] = [];
  const doors: Interactable[] = [];
  /** Where each door is in the world. */
  let doorsAt: { x: number; z: number }[] = [];
  /** Each building put up, and where it stands in the world (for the fog). */
  let standing: { group: THREE.Object3D; x: number; z: number }[] = [];

  const place = () => {
    for (const m of mine) Object.assign(m.c, { minX: m.base.minX - here.x, maxX: m.base.maxX - here.x, minZ: m.base.minZ - here.z, maxZ: m.base.maxZ - here.z, top: m.base.top - drop, bottom: (m.base.bottom ?? 0) - drop });
    doors.forEach((d, i) => Object.assign(d, { x: doorsAt[i].x - here.x, z: doorsAt[i].z - here.z, y: G - drop }));
  };
  const add = (c: Collider) => {
    const live = { ...c };
    mine.push({ c: live, base: c });
    colliders.push(live);
  };

  /** The ground of each district's cells, and every road of the Quarter (see QUARTER_ROADS), the way up from town too. */
  const lay = (state: WorldState) => {
    const g = new THREE.Group();
    const used = state.districts.flatMap((d) => d.cells).filter((c) => c < CELLS);
    for (const c of used) {
      const at = cellAt(c);
      box(g, PAVE, QUARTER.cellW - 14, 0.03, QUARTER.cellD - 14, at.x, G, at.z);
    }
    for (const r of QUARTER_ROADS) road(g, r);
    return mergeByColor(g);
  };

  /** A stretch of road: asphalt, a white line along each edge, and a dashed yellow one down the middle (as the main street). */
  const road = (g: THREE.Group, r: { minX: number; maxX: number; minZ: number; maxZ: number }) => {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    box(g, ASPHALT, w, 0.05, d, cx, G, cz);
    const along = w > d;
    const len = along ? w : d;
    const half = (along ? d : w) / 2 - 0.35;
    for (const side of [-1, 1]) box(g, '#f1f1f1', along ? len : 0.18, 0.06, along ? 0.18 : len, along ? cx : cx + side * half, G, along ? cz + side * half : cz);
    // Dashes 4 m long every 8 m, from the start of the stretch.
    for (let s = 2; s < len - 2; s += 8) box(g, '#ffd166', along ? 4 : 0.2, 0.065, along ? 0.2 : 4, along ? r.minX + s + 2 : cx, G, along ? cz : r.minZ + s + 2);
  };

  const district = (d: WorldDistrict): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    for (const b of d.buildings) {
      const at = plotAt(d.cells, b.slot);
      if (!at) continue;
      // You're in it: its floors stand on its plot, over its garage (see Grounds); only its reader's ours.
      if (b.key !== inside) {
        const { group, solid } = officeBuilding(b, night);
        group.position.set(at.x, 0, at.z);
        out.push(group);
        standing.push({ group, x: at.x, z: at.z });
        for (const c of solid) add({ ...c, minX: c.minX + at.x, maxX: c.maxX + at.x, minZ: c.minZ + at.z, maxZ: c.maxZ + at.z });
      }
      // Its card reader, at the foot of its steps, as the campus's: E there opens it.
      const post = reader();
      post.position.set(at.x + READER.x, G, at.z + READER.z);
      const it: Interactable = { kind: 'gitlabdoor', x: 0, z: 0, y: G, radius: 2.2, gitlabBuilding: b.key };
      post.userData.interact = it;
      out.push(post);
      doors.push(it);
      doorsAt.push({ x: at.x + READER.x, z: at.z + READER.z });
      add({ minX: at.x + READER.x - 0.1, maxX: at.x + READER.x + 0.1, minZ: at.z + READER.z - 0.1, maxZ: at.z + READER.z + 0.1, bottom: G, top: G + 1.5 });
    }
    // Its sign, on the corner of its first cell where the avenue along its front meets the street down its west side.
    const c = cellAt(d.cells[0]);
    const px = c.x - QUARTER.cellW / 2 + STREET_W / 2 + 2.2;
    const pz = frontOf(d.cells[0]) - STREET_W / 2 - 1.6;
    const g = pylon(d.name, d.buildings.length);
    g.position.set(px, G, pz);
    out.push(g);
    add({ minX: px - 0.6, maxX: px + 0.6, minZ: pz - 0.6, maxZ: pz + 0.6, bottom: G, top: G + 11 });
    return out;
  };

  const set = (state: WorldState | null) => {
    shown = state;
    // Only rebuilt when what it shows changed (not on every look the server takes).
    const key = state ? JSON.stringify([inside, state.districts.map((d) => [d.key, d.cells, d.buildings.map((b) => [b.key, b.slot, b.name, storeysOf(b)])])]) : '';
    if (key === built) return;
    built = key;
    for (const o of [...root.children]) dispose(o);
    for (const m of mine) {
      const i = colliders.indexOf(m.c);
      if (i >= 0) colliders.splice(i, 1);
    }
    mine = [];
    doors.length = 0;
    doorsAt = [];
    standing = [];
    if (!state || !state.districts.length) return;
    root.add(lay(state));
    for (const d of state.districts) if (d.cells.length && d.cells[0] < CELLS) root.add(...district(d));
    place();
  };

  return {
    world: {
      set,
      doors,
      setHere(at: { x: number; z: number }, building?: string) {
        here = at;
        if (building !== inside) {
          inside = building;
          set(shown);
        }
        place();
      },
      cull(at: { x: number; z: number }) {
        for (const s of standing) s.group.visible = Math.hypot(s.x - at.x, s.z - at.z) < DRAWN;
      },
    } satisfies GitLabQuarter,
    setLevel(index: number) {
      drop = index * STOREY;
      place();
    },
  };
}

export const gitlabQuarter: Fixture<'gitlabWorld', StreetSite> = (site) => {
  const built = buildQuarter(site.ground, site.colliders, site.get('night'));
  return { handle: { gitlabWorld: built.world }, setLevel: (index) => built.setLevel(index) };
};
