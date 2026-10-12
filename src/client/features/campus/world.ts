import * as THREE from 'three';
import { AVENUE, BOULEVARD, DISTRICT, DOOR, FOOTPRINT, READER, buildingAt, districtEnd, slotAt } from '../../../shared/campus';
import { EXIT_STAIRS, SLAB, STOREY, STREET_Y, WALL_HEIGHT } from '../../../shared/layout';
import type { CampusState } from '../../../shared/protocol';
import type { NightParts } from '../../world/outside';
import { mergeByMaterial, mesh, textPlane, toon, toonUnique } from '../../world/toon';
import { buildTower, type Tower } from '../../world/tower';
import type { Collider, Interactable } from '../../world/types';
import { buildExitStairs } from '../../world/office/balcony';
import type { Fixture, StreetSite } from '../../world/office/fixture';
import { exitDoor, type Door } from '../../world/office/shell';

// The campus round the building you're in: every other building, where it stands in the world (see
// shared/campus.ts), each the office's tower as tall as its floors, over its garage, with the exit
// door at the top of its steps and an ID card reader at their foot. The reader opens the door for
// you if your card does, and you walk in. The building you're in is the office floor itself, with
// its own reader at the foot of its steps and its owner's name on its garage. The district is built
// where it stands in the world, in the street's world group (see Grounds), which is drawn round
// wherever you are; what's in the way and what there is to use are put where that is.

declare module '../../world/types' {
  interface OfficeHandles {
    campus: CampusWorld;
  }
  interface Interactable {
    /** Which building a card reader is at (see BuildingInfo.id). */
    building?: string;
  }
}

export interface CampusWorld {
  /** Puts up every building but the one you're in, which stands at `here` in the world. */
  set(state: CampusState, here: { x: number; z: number }): void;
  /** The readers, the building you're in's first. */
  readers: Interactable[];
  /** A reader lights up green (its door opens) or red (not with your card). */
  flash(building: string, ok: boolean): void;
  /** `building`'s door opens for you, for a while (your card's been taken). */
  unlock(building: string): void;
  /** The building whose open door you're walking through, if you are: you at (x, y, z) on the map of the floor you're on. */
  walkingInto(x: number, y: number, z: number): string | null;
}

const G = STREET_Y;
const GARAGE_H = -STREET_Y - SLAB;
const IDLE = '#5aa9e6';
const GREEN = '#3ddc84';
const RED = '#ff4d4d';
/** How long a door stays open for you once your card's been taken. */
const OPEN_MS = 20_000;

/** A reader on its post: the post, the panel, the light that flashes, and its material. */
function readerPost(x: number, z: number, rotY: number): { group: THREE.Group; led: THREE.MeshToonMaterial } {
  const group = new THREE.Group();
  group.position.set(x, G, z);
  group.rotation.y = rotY;
  const dark = toon('#2b2d42');
  group.add(mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), toon('#8d99ae'), 0, 0.55, 0));
  group.add(mesh(new THREE.BoxGeometry(0.3, 0.42, 0.1), dark, 0, 1.25, 0.02));
  const led = toonUnique(IDLE);
  led.emissive.set(IDLE);
  led.emissiveIntensity = 0.8;
  group.add(mesh(new THREE.BoxGeometry(0.18, 0.05, 0.02), led, 0, 1.38, 0.08, false));
  // The card mark on its face.
  group.add(mesh(new THREE.BoxGeometry(0.16, 0.11, 0.015), toon('#edf2f4'), 0, 1.2, 0.075, false));
  return { group, led };
}

/** A name on a building's garage: on its front, facing the street, and by its steps, facing west. */
function nameSigns(name: string): THREE.Group {
  const g = new THREE.Group();
  const front = textPlane(`🏢 ${name}`, { size: 64, color: '#2b2d42', bg: '#fffaf3' });
  front.scale.setScalar(3.4);
  front.position.set(-4.8, G + 2.55, FOOTPRINT.maxZ + 0.06);
  const side = textPlane(`🏢 ${name}`, { size: 64, color: '#2b2d42', bg: '#fffaf3' });
  side.scale.setScalar(2.6);
  side.rotation.y = -Math.PI / 2;
  side.position.set(FOOTPRINT.minX - 0.06, G + 2.2, 0);
  g.add(front, side);
  return g;
}

/** What a building's name says: whose it is, and whether it's yours. */
const titleOf = (b: CampusState['buildings'][number]) => `${b.access ? '' : '🔒 '}${b.name}’s building${b.mine ? ' (yours)' : ''}`;

/** The brick path from the foot of the office's exit steps west to the boulevard: its middle, and how wide. */
const PATH = { z: EXIT_STAIRS.landingZ1 + 4.2, width: 2 } as const;

/** A sign on two posts: a title and a line under it, facing +z turned `rotY`, written on both faces. */
function signpost(title: string, sub: string, x: number, z: number, rotY: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, G, z);
  g.rotation.y = rotY;
  const wood = toon('#6d4c41');
  for (const side of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), wood, side * 1.1, 1.15, -0.04));
  g.add(mesh(new THREE.BoxGeometry(2.6, 1.0, 0.06), toon('#2b2d42'), 0, 2.0, -0.04));
  for (const back of [false, true]) {
    const face = new THREE.Group();
    if (back) face.rotation.y = Math.PI;
    face.position.z = back ? -0.08 : 0;
    const top = textPlane(title, { size: 64, color: '#fffaf3' });
    top.scale.setScalar(Math.min(1.4, 2.4 / (top.geometry.parameters.width || 1)));
    top.position.set(0, 2.2, 0);
    const under = textPlane(sub, { size: 40, color: '#ffd6a5' });
    under.scale.setScalar(Math.min(1.2, 2.4 / (under.geometry.parameters.width || 1)));
    under.position.set(0, 1.78, 0);
    face.add(top, under);
    g.add(face);
  }
  return g;
}

/** One building but the one you're in: kept, and only raised or lowered, renamed or moved after. */
interface Shell {
  group: THREE.Group;
  tower: Tower;
  roof: THREE.Mesh;
  /** Its name, rebuilt when it changes. */
  signs: THREE.Group;
  reader: { group: THREE.Group; led: THREE.MeshToonMaterial };
  it: Interactable;
  door: Door;
  /** What's in the way of it (its steps), from its middle, on its bottom floor. */
  solid: Collider[];
  /** Whose it is now (none while it's not put up), and where it stands. */
  building: string;
  at: { x: number; z: number };
  key: string;
}

export function buildCampus(ground: THREE.Group, colliders: Collider[], doors: Door[], night: NightParts) {
  // What's the building's own (its reader, its name) goes in its own street, which the world's is in.
  const own = ground.parent ?? ground;
  const group = new THREE.Group();
  ground.add(group);
  const paving = new THREE.Group();
  group.add(paving);
  const shells: Shell[] = [];
  const readers: Interactable[] = [];
  const leds = new Map<string, THREE.MeshToonMaterial>();
  const openUntil = new Map<string, number>();
  /** What's in the way now: where it stands in the world (on the bottom floor), and where it is on the floor you're on. */
  let mine: { c: Collider; base: Collider }[] = [];
  let drop = 0;
  let here = { x: 0, z: 0 };
  /** The other buildings' door lamps light nothing: theirs go nowhere. */
  const unlit = { ...night, bulbs: [], halos: [], lamps: [] } as NightParts;

  // The building you're in: its reader at the foot of its steps, and its name on its garage.
  const home = readerPost(READER.x, READER.z, -Math.PI / 2);
  own.add(home.group);
  const homeReader: Interactable = { kind: 'reader', x: READER.x, z: READER.z, y: G, radius: 2 };
  home.group.userData.interact = homeReader;
  const homeSign = new THREE.Group();
  own.add(homeSign);
  let homeKey = '';

  const concrete = toon('#c9ccd4');
  const pave = toon('#d8d2c4');
  const asphalt = toon('#6b6f7a');
  const brick = toon('#c2694f');
  const curb = toon('#efe6d6');
  const roofMat = toon('#fffaf3');

  /** The district's ground: the avenue in front of each row, pavement round it all, and the brick way up to it from the street. */
  const lay = (n: number) => {
    for (const o of [...paving.children]) {
      o.removeFromParent();
      o.traverse((m) => (m as THREE.Mesh).geometry?.dispose());
    }
    if (n <= 1) return;
    const parts = new THREE.Group();
    const rows = Math.ceil((n - 1) / DISTRICT.cols);
    const north = districtEnd(n);
    const south = slotAt(0).z + AVENUE.ahead + AVENUE.width / 2 + 2;
    const half = ((DISTRICT.cols - 1) / 2) * DISTRICT.pitchX + FOOTPRINT.maxX + 8;
    const flat = (w: number, d: number, mat: THREE.Material, x: number, z: number, y: number) => parts.add(mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat, x, G + y, z, false));
    flat(half * 2, south - north, pave, 0, (south + north) / 2, 0.03);
    for (let r = 0; r < rows; r++) flat(half * 2, AVENUE.width, asphalt, 0, slotAt(r * DISTRICT.cols).z + AVENUE.ahead, 0.05);
    // The boulevard in brick between white curbs, and a brick path to it from the foot of the office's steps.
    const length = BOULEVARD.fromZ - south;
    const mid = (BOULEVARD.fromZ + south) / 2;
    flat(BOULEVARD.width, length, brick, BOULEVARD.x, mid, 0.04);
    for (const side of [-1, 1]) flat(0.4, length, curb, BOULEVARD.x + side * (BOULEVARD.width / 2 + 0.2), mid, 0.045);
    const pathX0 = BOULEVARD.x + BOULEVARD.width / 2;
    const pathX1 = EXIT_STAIRS.minX - 0.2;
    flat(pathX1 - pathX0, PATH.width, brick, (pathX0 + pathX1) / 2, PATH.z, 0.04);
    paving.add(mergeByMaterial(parts));
    // Signs the way there: where the boulevard leaves the street, and at the foot of the office's steps.
    const more = `${n - 1} building${n === 2 ? '' : 's'}`;
    paving.add(signpost('🏙️ The district ⬆', `${more} up the brick path`, BOULEVARD.x + BOULEVARD.width / 2 + 0.9, BOULEVARD.fromZ - 0.6, 0));
    paving.add(signpost('🏙️ The district', `${more}: ⬅ west on the brick path, then north`, EXIT_STAIRS.minX - 1.4, PATH.z + PATH.width / 2 + 0.6, Math.PI));
  };

  const shellOf = (i: number): Shell => {
    if (shells[i]) return shells[i];
    const g = new THREE.Group();
    const tower = buildTower([], night);
    g.add(tower.group);
    const w = FOOTPRINT.maxX - FOOTPRINT.minX;
    const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
    const roof = mesh(new THREE.BoxGeometry(w, SLAB, d), roofMat, 0, 0, 0, false);
    g.add(roof);
    // Its garage, walled up, and the steps up its west side to its door.
    g.add(mesh(new THREE.BoxGeometry(w, GARAGE_H, d), concrete, 0, G + GARAGE_H / 2, 0));
    const stairs = new THREE.Group();
    const solid: Collider[] = [];
    buildExitStairs(stairs, solid);
    g.add(mergeByMaterial(stairs));
    const exit = exitDoor(unlit);
    g.add(exit.group);
    const reader = readerPost(READER.x, READER.z, -Math.PI / 2);
    g.add(reader.group);
    const it: Interactable = { kind: 'reader', x: 0, z: 0, y: G, radius: 2 };
    reader.group.userData.interact = it;
    const signs = new THREE.Group();
    g.add(signs);
    const door = exit.door;
    door.locked = true;
    doors.push(door);
    const shell: Shell = { group: g, tower, roof, signs, reader, it, door, solid, building: '', at: { x: 0, z: 0 }, key: '' };
    group.add(g);
    return (shells[i] = shell);
  };

  /** Puts what's in the way, the readers and the doors where they are on the floor you're on. */
  const place = () => {
    for (const m of mine) {
      Object.assign(m.c, { minX: m.base.minX - here.x, maxX: m.base.maxX - here.x, minZ: m.base.minZ - here.z, maxZ: m.base.maxZ - here.z, top: m.base.top - drop, bottom: (m.base.bottom ?? 0) - drop });
    }
    homeReader.y = G - drop;
    for (const s of shells) {
      if (!s.building) continue;
      Object.assign(s.it, { x: s.at.x + READER.x - here.x, z: s.at.z + READER.z - here.z, y: G - drop });
      Object.assign(s.door, { x: s.at.x + DOOR.x - here.x, z: s.at.z + DOOR.z - here.z, y: -drop });
    }
  };

  const set = (state: CampusState, at: { x: number; z: number }) => {
    here = at;
    for (const m of mine) {
      const i = colliders.indexOf(m.c);
      if (i >= 0) colliders.splice(i, 1);
    }
    mine = [];
    readers.length = 0;
    leds.clear();
    leds.set(state.here, home.led);
    readers.push(homeReader);
    homeReader.building = state.here;
    const n = state.buildings.length;
    lay(n);
    const add = (c: Collider, x: number, z: number) => {
      const base = { ...c, minX: c.minX + x, maxX: c.maxX + x, minZ: c.minZ + z, maxZ: c.maxZ + z };
      const live = { ...base };
      mine.push({ c: live, base });
      colliders.push(live);
    };
    // The name of the one you're in, once there's more than one.
    const hereB = state.buildings.find((b) => b.id === state.here);
    const name = hereB && n > 1 ? titleOf(hereB) : '';
    if (name !== homeKey) {
      homeKey = name;
      for (const o of [...homeSign.children]) o.removeFromParent();
      if (name) homeSign.add(nameSigns(name));
    }
    let k = 0;
    state.buildings.forEach((b, i) => {
      if (b.id === state.here) return;
      const s = shellOf(k++);
      const pos = buildingAt(i);
      s.building = b.id;
      s.at = pos;
      s.it.building = b.id;
      s.group.visible = true;
      s.group.position.set(pos.x, 0, pos.z);
      const floors = Math.max(1, b.floors);
      const key = `${titleOf(b)}|${b.floors}`;
      if (s.key !== key) {
        s.key = key;
        // The tower's floors stand from the bottom one (level with the street's floor 0) up.
        s.tower.set(floors, floors);
        s.tower.group.position.y = floors * STOREY;
        s.roof.position.y = (floors - 1) * STOREY + WALL_HEIGHT + SLAB / 2;
        for (const o of [...s.signs.children]) o.removeFromParent();
        s.signs.add(nameSigns(`${titleOf(b)} · ${b.floors ? `${b.floors} floor${b.floors === 1 ? '' : 's'}` : 'no floors yet'}`));
      }
      s.door.locked = !((openUntil.get(b.id) ?? 0) > performance.now());
      const top = (floors - 1) * STOREY + WALL_HEIGHT + SLAB;
      add({ ...FOOTPRINT, bottom: G, top }, pos.x, pos.z);
      for (const c of s.solid) add(c, pos.x, pos.z);
      add({ minX: READER.x - 0.1, maxX: READER.x + 0.1, minZ: READER.z - 0.1, maxZ: READER.z + 0.1, bottom: G, top: G + 1.5 }, pos.x, pos.z);
      readers.push(s.it);
      leds.set(b.id, s.reader.led);
    });
    for (let i = k; i < shells.length; i++) {
      shells[i].group.visible = false;
      shells[i].building = '';
      shells[i].door.locked = true;
      shells[i].door.y = 1e6;
    }
    place();
  };

  /** How long a reader stays lit after a tap, by its material. */
  const lit = new Map<THREE.MeshToonMaterial, number>();
  const flash = (building: string, ok: boolean) => {
    const led = leds.get(building);
    if (!led) return;
    const color = ok ? GREEN : RED;
    led.color.set(color);
    led.emissive.set(color);
    led.emissiveIntensity = 1.6;
    lit.set(led, 1.6);
  };
  const unlock = (building: string) => {
    openUntil.set(building, performance.now() + OPEN_MS);
    const s = shells.find((x) => x.building === building);
    if (s) s.door.locked = false;
  };
  const walkingInto = (x: number, y: number, z: number): string | null => {
    for (const s of shells) {
      if (!s.building || s.door.locked || s.door.open < 0.6) continue;
      if (Math.abs(y - s.door.y) > 1 || Math.abs(z - s.door.z) > 0.7 || x < s.door.x - 0.9 || x > s.door.x + 0.6) continue;
      return s.building;
    }
    return null;
  };
  const update = (dt: number) => {
    for (const [led, left] of lit) {
      const now = left - dt;
      if (now > 0) {
        lit.set(led, now);
        continue;
      }
      lit.delete(led);
      led.color.set(IDLE);
      led.emissive.set(IDLE);
      led.emissiveIntensity = 0.8;
    }
    // A door your card opened shuts again after a while.
    const now = performance.now();
    for (const s of shells) if (s.building && !s.door.locked && (openUntil.get(s.building) ?? 0) < now) s.door.locked = true;
  };
  const setLevel = (index: number) => {
    drop = index * STOREY;
    place();
  };
  const world: CampusWorld = { set, readers, flash, unlock, walkingInto };
  return { world, update, setLevel };
}

/** The campus, out in the world (see inWorld): it goes down with the street on the floors above the bottom one. */
export const campus: Fixture<'campus', StreetSite> = (site) => {
  const built = buildCampus(site.ground, site.colliders, site.doors, site.get('night'));
  return { handle: { campus: built.world }, update: (_t, dt) => built.update(dt), setLevel: (index) => built.setLevel(index) };
};
