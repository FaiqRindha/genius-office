import * as THREE from 'three';
import { CELLS, QUARTER, QUARTER_ROADS, cellAt, plotAt } from '../../../shared/gitlab-quarter';
import type { WorldBuilding, WorldDistrict, WorldState } from '../../../shared/gitlab-world';
import { STOREY, STREET_Y } from '../../../shared/layout';
import { mergeByColor, mesh, textPlane, toon } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';
import { styleOf, type Style } from './style';

// The GitLab Quarter: every project on the GitLab, standing north of the town (see
// shared/gitlab-quarter.ts for where, shared/gitlab-world.ts for what). A district is a block of
// buildings behind a gate with its group's name; each building is its namespace, as tall as it has
// projects, in a look of its own (see style.ts). Each district is merged into a mesh a colour, so a
// whole district is a handful of draw calls however many windows it has. You can walk round them; going
// in comes later. Built in the street's world group, where it stands in the world, like the campus.

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
  /** Where the building you're in stands in the world (see standsAt): what's in the way moves round it. */
  setHere(at: { x: number; z: number }): void;
  /** Each building's door, where it is on the floor you're on (E there to go in: see index.ts). */
  doors: Interactable[];
}

const G = STREET_Y;
const PAVE = '#c9c2b8';
const ASPHALT = '#5b606c';
const LAWN = '#8cb369';
const SIGN = { color: '#2b2d42', bg: '#fffaf3' } as const;

/** A box `w` × `h` × `d` with its bottom at y, in `group`. */
function box(group: THREE.Object3D, color: string, w: number, h: number, d: number, x: number, y: number, z: number) {
  group.add(mesh(new THREE.BoxGeometry(w, h, d), toon(color), x, y + h / 2, z));
}

/** The windows of one face of a volume: `across` wide, facing +z (turned by the caller). */
function windowsOn(face: THREE.Group, s: Style, across: number, storeys: number, from: number) {
  const out = 0.12;
  for (let i = 0; i < storeys; i++) {
    const y = from + i * s.storeyH;
    if (s.windows === 'bands') box(face, s.glass, across - 1.2, s.storeyH * 0.45, out, 0, y + s.storeyH * 0.3, 0);
    else if (s.windows === 'grid') {
      const n = Math.max(1, Math.floor((across - 1) / 3));
      const gap = (across - 1) / n;
      for (let k = 0; k < n; k++) box(face, s.glass, gap * 0.55, s.storeyH * 0.5, out, -(across - 1) / 2 + gap * (k + 0.5), y + s.storeyH * 0.25, 0);
    } else box(face, s.trim, across - 0.4, 0.18, out + 0.04, 0, y, 0);
  }
  if (s.windows === 'curtain') {
    // One sheet of glass, with mullions up it.
    box(face, s.glass, across - 0.6, storeys * s.storeyH - 0.3, out, 0, from + 0.15, 0);
    const n = Math.max(2, Math.round(across / 3));
    for (let k = 0; k <= n; k++) box(face, s.trim, 0.14, storeys * s.storeyH, out + 0.05, -(across - 0.6) / 2 + ((across - 0.6) / n) * k, from, 0);
  }
}

/** A volume of the building: its walls, windows round all four faces, and a cornice. Its top. */
function volume(g: THREE.Group, s: Style, w: number, d: number, storeys: number, x: number, z: number, from: number): number {
  const h = storeys * s.storeyH;
  box(g, s.facade, w, h, d, x, from, z);
  for (const [rot, across, off] of [
    [0, w, d / 2],
    [Math.PI, w, d / 2],
    [Math.PI / 2, d, w / 2],
    [-Math.PI / 2, d, w / 2],
  ] as const) {
    const face = new THREE.Group();
    face.rotation.y = rot;
    face.position.set(x + Math.sin(rot) * off, 0, z + Math.cos(rot) * off);
    windowsOn(face, s, across, storeys, from);
    g.add(face);
  }
  box(g, s.trim, w + 0.5, 0.45, d + 0.5, x, from + h, z);
  return from + h + 0.45;
}

/** What tops it: on a roof `w` × `d` at height `y`. */
function roof(g: THREE.Group, s: Style, w: number, d: number, x: number, z: number, y: number) {
  const parapet = (color: string) => {
    box(g, color, w, 0.8, 0.3, x, y, z + d / 2 - 0.15);
    box(g, color, w, 0.8, 0.3, x, y, z - d / 2 + 0.15);
    box(g, color, 0.3, 0.8, d, x + w / 2 - 0.15, y, z);
    box(g, color, 0.3, 0.8, d, x - w / 2 + 0.15, y, z);
  };
  switch (s.roof) {
    case 'flat':
      parapet(s.trim);
      box(g, '#8d99ae', w * 0.25, 1.4, d * 0.2, x - w * 0.2, y, z + d * 0.15);
      break;
    case 'garden':
      parapet(s.trim);
      box(g, LAWN, w - 1, 0.25, d - 1, x, y, z);
      for (const [fx, fz] of [
        [-0.25, -0.2],
        [0.2, 0.15],
        [-0.1, 0.25],
      ])
        g.add(mesh(new THREE.SphereGeometry(1.1, 8, 6), toon('#55a630'), x + fx * w, y + 1.5, z + fz * d));
      break;
    case 'antenna':
      parapet(s.trim);
      g.add(mesh(new THREE.CylinderGeometry(0.12, 0.2, 8, 6), toon('#adb5bd'), x, y + 4, z));
      g.add(mesh(new THREE.SphereGeometry(0.35, 8, 6), toon('#e63946', { emissive: '#e63946' }), x, y + 8.2, z));
      break;
    case 'helipad': {
      const r = Math.min(w, d) * 0.4;
      g.add(mesh(new THREE.CylinderGeometry(r, r, 0.3, 24), toon('#343a40'), x, y + 0.15, z));
      box(g, '#ffd166', 0.5, 0.05, r, x - r * 0.3, y + 0.3, z);
      box(g, '#ffd166', 0.5, 0.05, r, x + r * 0.3, y + 0.3, z);
      box(g, '#ffd166', r * 0.6, 0.05, 0.5, x, y + 0.3, z);
      break;
    }
    case 'pitched': {
      // A gable along its length: a three-sided prism lying on its side.
      const prism = mesh(new THREE.CylinderGeometry(d / Math.sqrt(3), d / Math.sqrt(3), w + 0.4, 3), toon(s.trim), x, y + d / (2 * Math.sqrt(3)), z);
      prism.rotation.set(0, 0, Math.PI / 2);
      prism.rotation.x = Math.PI / 2;
      g.add(prism);
      break;
    }
    case 'dome': {
      const r = Math.min(w, d) * 0.38;
      g.add(mesh(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon(s.glass), x, y, z));
      break;
    }
  }
}

/** A building of the Quarter, its front (+z) to the avenue, its middle at (0, 0): and how far it reaches. */
export function building(b: Pick<WorldBuilding, 'key' | 'floors'>): { group: THREE.Group; style: Style; height: number } {
  const s = styleOf(b.key, b.floors.length);
  const g = new THREE.Group();
  const n = s.storeys;
  let top: number;
  let w = s.w;
  let d = s.d;
  switch (s.shape) {
    case 'stepped': {
      // Three tiers, each set back from the one under it.
      const tiers = [Math.ceil(n * 0.5), Math.ceil(n * 0.3), n - Math.ceil(n * 0.5) - Math.ceil(n * 0.3)].filter((t) => t > 0);
      top = 0;
      tiers.forEach((t, i) => {
        const k = 1 - i * 0.22;
        top = volume(g, s, s.w * k, s.d * k, t, 0, 0, top);
      });
      w = s.w * (1 - (tiers.length - 1) * 0.22);
      d = s.d * (1 - (tiers.length - 1) * 0.22);
      break;
    }
    case 'podium': {
      // Two broad storeys, and a tower out of them.
      const base = volume(g, { ...s, windows: 'bands' }, s.w + 6, s.d + 4, 2, 0, 0, 0);
      w = s.w * 0.6;
      d = s.d * 0.6;
      top = volume(g, s, w, d, Math.max(1, n - 2), 0, -1, base);
      break;
    }
    case 'twin': {
      // Two towers and a bridge between them high up.
      const tw = s.w * 0.4;
      const left = volume(g, s, tw, s.d, n, -s.w * 0.3, 0, 0);
      volume(g, s, tw, s.d, Math.max(1, n - 1), s.w * 0.3, 0, 0);
      box(g, s.glass, s.w * 0.2 + 0.4, s.storeyH * 0.8, 3, 0, left * 0.6, 0);
      top = left;
      w = tw;
      roof(g, s, tw, s.d, s.w * 0.3, 0, left - s.storeyH);
      roof(g, s, tw, s.d, -s.w * 0.3, 0, top);
      return { group: g, style: s, height: top + 9 };
    }
    default:
      top = volume(g, s, s.w, s.d, n, 0, 0, 0);
  }
  roof(g, s, w, d, 0, s.shape === 'podium' ? -1 : 0, top);
  // A canopy over its way in, on the avenue side (the door itself is its own, to be pointed at: see district).
  const front = (s.shape === 'podium' ? s.d + 4 : s.d) / 2;
  box(g, s.trim, 5, 0.3, 2.4, 0, 3.4, front + 1.2);
  return { group: g, style: s, height: top + 9 };
}

/** Text with no card behind it: no outline round its plane (the toon outline would draw a box). */
function bare(t: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>) {
  t.material.userData.outlineParameters = { visible: false };
  return t;
}

/** A gate over the way into a district: two pillars, a beam, and its group's name. */
function gate(name: string, buildings: number): THREE.Group {
  const g = new THREE.Group();
  const stone = toon('#6c757d');
  for (const side of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(1.4, 9, 1.4), stone, side * 9, 4.5, 0));
  g.add(mesh(new THREE.BoxGeometry(20, 1.6, 1.6), toon('#2b2d42'), 0, 9.6, 0));
  for (const back of [false, true]) {
    const t = bare(textPlane(`🦊 ${name}`, { size: 72, color: '#fffaf3' }));
    t.scale.setScalar(Math.min(6, 17 / (t.geometry.parameters.width || 1)));
    t.position.set(0, 9.6, back ? -0.82 : 0.82);
    if (back) t.rotation.y = Math.PI;
    const sub = textPlane(`${buildings} building${buildings === 1 ? '' : 's'}`, { size: 40, color: '#2b2d42', bg: '#ffd6a5' });
    sub.scale.setScalar(2.2);
    sub.position.set(0, 7.9, back ? -0.82 : 0.82);
    if (back) sub.rotation.y = Math.PI;
    g.add(t, sub);
  }
  return g;
}

/** A building's name over its door, as wide as most of its front, and how many projects it has. */
function nameSign(b: WorldBuilding, front: number, across: number): THREE.Group {
  const g = new THREE.Group();
  const live = b.floors.filter((f) => !f.archived).length;
  const t = textPlane(b.name, { size: 64, ...SIGN });
  t.scale.setScalar(Math.min(7, (across * 0.7) / (t.geometry.parameters.width || 1)));
  const tall = t.geometry.parameters.height * t.scale.y;
  t.position.set(0, 4.6 + tall / 2, front + 0.3);
  const sub = textPlane(`${live} project${live === 1 ? '' : 's'}`, { size: 40, color: '#fffaf3', bg: '#2b2d42' });
  sub.scale.setScalar(2.6);
  sub.position.set(0, 4.6 - 0.1 - (sub.geometry.parameters.height * 2.6) / 2, front + 0.3);
  g.add(t, sub);
  return g;
}

/** Throws away what a group was built of. */
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

export function buildQuarter(ground: THREE.Group, colliders: Collider[]) {
  const root = new THREE.Group();
  root.name = 'gitlab-quarter';
  ground.add(root);
  let built = '';
  let here = { x: 0, z: 0 };
  let drop = 0;
  let mine: { c: Collider; base: Collider }[] = [];
  const doors: Interactable[] = [];
  /** Where each door is in the world. */
  let doorsAt: { x: number; z: number }[] = [];

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
      box(g, PAVE, QUARTER.cellW - 14, 0.06, QUARTER.cellD - 14, at.x, G, at.z);
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
    const solid = new THREE.Group();
    const signs = new THREE.Group();
    for (const b of d.buildings) {
      const at = plotAt(d.cells, b.slot);
      if (!at) continue;
      const { group, style, height } = building(b);
      group.position.set(at.x, G, at.z);
      solid.add(group);
      const front = (style.shape === 'podium' ? style.d + 4 : style.d) / 2;
      const sign = nameSign(b, front, style.shape === 'twin' ? style.w * 0.4 : style.shape === 'podium' ? style.w + 6 : style.w);
      sign.position.set(at.x, G, at.z);
      signs.add(sign);
      const w = (style.shape === 'podium' ? style.w + 6 : style.w) / 2;
      add({ minX: at.x - w, maxX: at.x + w, minZ: at.z - front, maxZ: at.z + front, bottom: G, top: G + height });
      // Its door, under the canopy: one of its own, not merged, so the aim lands on it (it's what you use).
      const it: Interactable = { kind: 'gitlabdoor', x: 0, z: 0, y: G, radius: 2.4, gitlabBuilding: b.key };
      doors.push(it);
      doorsAt.push({ x: at.x, z: at.z + front + 1.4 });
      const door = mesh(new THREE.BoxGeometry(3.2, 3, 0.3), toon('#2b2d42'), at.x, G + 1.5, at.z + front + 0.1);
      door.userData.interact = it;
      signs.add(door);
    }
    // The gate, on the avenue along the front of its first cell.
    const c = cellAt(d.cells[0]);
    const gz = c.z + QUARTER.cellD / 2 - 8;
    const g = gate(d.name, d.buildings.length);
    g.position.set(c.x, G, gz);
    signs.add(g);
    for (const side of [-1, 1]) add({ minX: c.x + side * 9 - 0.7, maxX: c.x + side * 9 + 0.7, minZ: gz - 0.7, maxZ: gz + 0.7, bottom: G, top: G + 9 });
    return [mergeByColor(solid), signs];
  };

  const set = (state: WorldState | null) => {
    // Only rebuilt when what it shows changed (not on every look the server takes).
    const key = state ? JSON.stringify(state.districts.map((d) => [d.key, d.cells, d.buildings.map((b) => [b.key, b.slot, b.name, b.floors.length])])) : '';
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
    if (!state || !state.districts.length) return;
    root.add(lay(state));
    for (const d of state.districts) if (d.cells.length && d.cells[0] < CELLS) root.add(...district(d));
    place();
  };

  return {
    world: {
      set,
      doors,
      setHere(at: { x: number; z: number }) {
        here = at;
        place();
      },
    } satisfies GitLabQuarter,
    setLevel(index: number) {
      drop = index * STOREY;
      place();
    },
  };
}

export const gitlabQuarter: Fixture<'gitlabWorld', StreetSite> = (site) => {
  const built = buildQuarter(site.ground, site.colliders);
  return { handle: { gitlabWorld: built.world }, setLevel: (index) => built.setLevel(index) };
};

