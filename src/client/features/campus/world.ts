import * as THREE from 'three';
import { AVENUE, BOULEVARD, DISTRICT, ENTRANCE, FOOTPRINT, HOME_READER, READER, districtEnd, slotAt } from '../../../shared/campus';
import { EXIT_STAIRS, SLAB, STOREY, STREET_Y, WALL_HEIGHT } from '../../../shared/layout';
import type { CampusState } from '../../../shared/protocol';
import type { NightParts } from '../../world/outside';
import { mergeByMaterial, mesh, textPlane, toon, toonUnique } from '../../world/toon';
import { buildTower, type Tower } from '../../world/tower';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';

// The campus round the office: every other building, in its slot in the district north of the street
// (see shared/campus.ts), each the office's tower as tall as its floors, over a garage with glass doors
// at the west end of its front and an ID card reader on a post by them. The office's own reader is at
// the foot of its exit steps. The building you're in has a plaza in its slot.

declare module '../../world/types' {
  interface OfficeHandles {
    campus: CampusWorld;
  }
  interface Interactable {
    /** Which building a card reader is the door of (see BuildingInfo.id). */
    building?: string;
  }
}

export interface CampusWorld {
  /** Puts up every building but the one you're in, where the campus says. */
  set(state: CampusState): void;
  /** The readers, the office's own first. */
  readonly readers: Interactable[];
  /** A reader lights up green (in you go) or red (not with your card). */
  flash(building: string, ok: boolean): void;
}

const G = STREET_Y;
const GARAGE_H = -STREET_Y - SLAB;
const IDLE = '#5aa9e6';
const GREEN = '#3ddc84';
const RED = '#ff4d4d';

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

/** The brick path from the foot of the office's exit steps west to the boulevard: its middle, and how wide. */
const PATH = { z: EXIT_STAIRS.landingZ1 + 4.2, width: 2 } as const;

/** A sign on two posts: a title and a line under it, facing +z turned `rotY`. */
function signpost(title: string, sub: string, x: number, z: number, rotY: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, G, z);
  g.rotation.y = rotY;
  const wood = toon('#6d4c41');
  for (const side of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), wood, side * 1.1, 1.15, -0.06));
  g.add(mesh(new THREE.BoxGeometry(2.6, 1.0, 0.06), toon('#2b2d42'), 0, 2.0, -0.04));
  const top = textPlane(title, { size: 64, color: '#fffaf3' });
  top.scale.setScalar(Math.min(1.4, 2.4 / (top.geometry.parameters.width || 1)));
  top.position.set(0, 2.2, 0);
  const under = textPlane(sub, { size: 40, color: '#ffd6a5' });
  under.scale.setScalar(Math.min(1.2, 2.4 / (under.geometry.parameters.width || 1)));
  under.position.set(0, 1.78, 0);
  g.add(top, under);
  return g;
}

/** One slot's building: its tower (kept, and only raised or lowered after), garage, doors, sign and reader. */
interface Slot {
  group: THREE.Group;
  tower: Tower;
  /** The garage, doors and sign: rebuilt when its owner or height changes. */
  base: THREE.Group;
  roof: THREE.Mesh;
  reader: { group: THREE.Group; led: THREE.MeshToonMaterial };
  key: string;
}

export function buildCampus(ground: THREE.Group, colliders: Collider[], night: NightParts) {
  const group = new THREE.Group();
  ground.add(group);
  const paving = new THREE.Group();
  group.add(paving);
  const slots: Slot[] = [];
  const readers: Interactable[] = [];
  const leds = new Map<string, THREE.MeshToonMaterial>();
  /** What's in the way now, as built (on the bottom floor), and how far down the street is from there. */
  let mine: { c: Collider; top: number; bottom: number }[] = [];
  let drop = 0;

  const home = readerPost(HOME_READER.x, HOME_READER.z, -Math.PI / 2);
  ground.add(home.group);
  const homeReader: Interactable = { kind: 'reader', x: HOME_READER.x, z: HOME_READER.z, y: G, radius: 2 };
  // What the crosshair finds when it lands on the reader.
  home.group.userData.interact = homeReader;

  const concrete = toon('#c9ccd4');
  const glass = toon('#9fd3ff', { opacity: 0.55 });
  const pave = toon('#d8d2c4');
  const asphalt = toon('#6b6f7a');
  const brick = toon('#c2694f');
  const curb = toon('#efe6d6');
  const roofMat = toon('#fffaf3');

  /** The district's ground: the boulevard up from the street, an avenue in front of each row, and pavement round it all. */
  const lay = (n: number) => {
    for (const o of [...paving.children]) {
      o.removeFromParent();
      o.traverse((m) => (m as THREE.Mesh).geometry?.dispose());
    }
    if (n === 0) return;
    const parts = new THREE.Group();
    const rows = Math.ceil(n / DISTRICT.cols);
    const north = districtEnd(n);
    const south = slotAt(0).z + AVENUE.ahead + AVENUE.width / 2 + 2;
    const half = ((DISTRICT.cols - 1) / 2) * DISTRICT.pitchX + FOOTPRINT.maxX + 8;
    const flat = (w: number, d: number, mat: THREE.Material, x: number, z: number, y: number) => parts.add(mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat, x, G + y, z, false));
    flat(half * 2, south - north, pave, 0, (south + north) / 2, 0.03);
    for (let r = 0; r < rows; r++) flat(half * 2, AVENUE.width, asphalt, 0, slotAt(r * DISTRICT.cols).z + AVENUE.ahead, 0.05);
    // The boulevard in brick between white curbs, and a brick path to it from the foot of the exit steps.
    const length = BOULEVARD.fromZ - south;
    const mid = (BOULEVARD.fromZ + south) / 2;
    flat(BOULEVARD.width, length, brick, BOULEVARD.x, mid, 0.04);
    for (const side of [-1, 1]) flat(0.4, length, curb, BOULEVARD.x + side * (BOULEVARD.width / 2 + 0.2), mid, 0.045);
    const pathX0 = BOULEVARD.x + BOULEVARD.width / 2;
    const pathX1 = EXIT_STAIRS.minX - 0.2;
    flat(pathX1 - pathX0, PATH.width, brick, (pathX0 + pathX1) / 2, PATH.z, 0.04);
    paving.add(mergeByMaterial(parts));
    // Signs the way there: where the boulevard leaves the street, and at the foot of the exit steps.
    const others = n - 1;
    const more = `${others} other building${others === 1 ? '' : 's'}`;
    paving.add(signpost('🏙️ Other buildings ⬆', `${more} up the brick path`, BOULEVARD.x + BOULEVARD.width / 2 + 0.9, BOULEVARD.fromZ - 0.6, 0));
    paving.add(signpost('🏙️ Other buildings', `${more}: ⬅ west on the brick path, then north`, EXIT_STAIRS.minX - 1.4, PATH.z + PATH.width / 2 + 0.6, Math.PI));
  };

  /** The garage under a building, its glass doors, and its name over them. */
  const baseOf = (name: string, floors: number, access: boolean): THREE.Group => {
    const base = new THREE.Group();
    const w = FOOTPRINT.maxX - FOOTPRINT.minX;
    const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
    base.add(mesh(new THREE.BoxGeometry(w, GARAGE_H, d), concrete, 0, G + GARAGE_H / 2, 0));
    // The doors, standing a little proud of the front.
    base.add(mesh(new THREE.BoxGeometry(ENTRANCE.width, 2.4, 0.08), glass, ENTRANCE.x, G + 1.2, FOOTPRINT.maxZ + 0.05, false));
    base.add(mesh(new THREE.BoxGeometry(ENTRANCE.width + 0.3, 0.15, 0.14), toon('#3d405b'), ENTRANCE.x, G + 2.45, FOOTPRINT.maxZ + 0.06, false));
    const sign = textPlane(`${access ? '🏢' : '🔒'} ${name}`, { size: 64, color: '#2b2d42', bg: '#fffaf3' });
    sign.scale.setScalar(5);
    sign.position.set(0, G + GARAGE_H / 2 + 0.5, FOOTPRINT.maxZ + 0.04);
    base.add(sign);
    const sub = textPlane(floors ? `${floors} floor${floors === 1 ? '' : 's'}` : 'no floors yet', { size: 40, color: '#4a4e69', bg: '#fffaf3' });
    sub.scale.setScalar(3.2);
    sub.position.set(0, G + GARAGE_H / 2 - 1.1, FOOTPRINT.maxZ + 0.04);
    base.add(sub);
    return base;
  };

  const slotFor = (i: number): Slot => {
    if (slots[i]) return slots[i];
    const g = new THREE.Group();
    const at = slotAt(i);
    g.position.set(at.x, 0, at.z);
    const tower = buildTower([], night);
    g.add(tower.group);
    const roof = mesh(new THREE.BoxGeometry(FOOTPRINT.maxX - FOOTPRINT.minX, SLAB, FOOTPRINT.maxZ - FOOTPRINT.minZ), roofMat, 0, 0, 0, false);
    g.add(roof);
    const reader = readerPost(READER.x, READER.z, 0);
    g.add(reader.group);
    const slot: Slot = { group: g, tower, base: new THREE.Group(), roof, reader, key: '' };
    g.add(slot.base);
    group.add(g);
    return (slots[i] = slot);
  };

  /** Puts what's in the way back, as far down as the street is now. */
  const place = () => {
    for (const m of mine) {
      m.c.top = m.top - drop;
      m.c.bottom = m.bottom - drop;
    }
    for (const r of readers) r.y = G - drop;
    homeReader.y = G - drop;
  };

  const set = (state: CampusState) => {
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
    lay(n > 1 ? n : 0);
    const add = (c: Collider) => {
      mine.push({ c, top: c.top, bottom: c.bottom ?? 0 });
      colliders.push(c);
    };
    state.buildings.forEach((b, i) => {
      const s = slotFor(i);
      const here = b.id === state.here;
      const at = slotAt(i);
      s.group.visible = true;
      if (here) {
        // Your building's slot: a plaza, and a sign saying where it is.
        const key = `here|${b.name}`;
        if (s.key !== key) {
          s.key = key;
          s.base.clear();
          const sign = textPlane(`📍 ${b.name}'s building is the one on the main street`, { size: 48, color: '#2b2d42', bg: '#fffaf3' });
          sign.scale.setScalar(2);
          sign.position.set(0, G + 2.4, FOOTPRINT.maxZ);
          s.base.add(sign);
        }
        s.tower.group.visible = false;
        s.roof.visible = false;
        s.reader.group.visible = false;
        return;
      }
      s.tower.group.visible = true;
      s.roof.visible = true;
      s.reader.group.visible = true;
      const floors = Math.max(1, b.floors);
      const key = `${b.name}|${b.floors}|${b.access}`;
      if (s.key !== key) {
        s.key = key;
        // The tower's floors stand from the bottom one (level with the office's) up.
        s.tower.set(floors, floors);
        s.tower.group.position.y = floors * STOREY;
        s.roof.position.y = (floors - 1) * STOREY + WALL_HEIGHT + SLAB / 2;
        s.base.clear();
        s.base.add(baseOf(b.name, b.floors, b.access));
      }
      const top = (floors - 1) * STOREY + WALL_HEIGHT + SLAB;
      add({ minX: at.x + FOOTPRINT.minX, maxX: at.x + FOOTPRINT.maxX, minZ: at.z + FOOTPRINT.minZ, maxZ: at.z + FOOTPRINT.maxZ, bottom: G, top });
      add({ minX: at.x + READER.x - 0.1, maxX: at.x + READER.x + 0.1, minZ: at.z + READER.z - 0.1, maxZ: at.z + READER.z + 0.1, bottom: G, top: G + 1.5 });
      const it: Interactable = { kind: 'reader', x: at.x + READER.x, z: at.z + READER.z, y: G, radius: 2, building: b.id };
      s.reader.group.userData.interact = it;
      readers.push(it);
      leds.set(b.id, s.reader.led);
    });
    for (let i = n; i < slots.length; i++) slots[i].group.visible = false;
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
  };
  const setLevel = (index: number) => {
    drop = index * STOREY;
    place();
  };
  const world: CampusWorld = { set, readers, flash };
  return { world, update, setLevel };
}

/** The campus, down on the street: it goes down with it on the floors above the bottom one. */
export const campus: Fixture<'campus', StreetSite> = (site) => {
  const built = buildCampus(site.ground, site.colliders, site.get('night'));
  return { handle: { campus: built.world }, update: (_t, dt) => built.update(dt), setLevel: (index) => built.setLevel(index) };
};
