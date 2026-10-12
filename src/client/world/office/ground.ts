import * as THREE from 'three';
import { EXIT_DOOR, STOREY, streetBelow } from '../../../shared/layout';
import { buildGarage, type Lamp } from '../outside';
import { mergeByMaterial } from '../toon';
import type { Collider } from '../types';
import { buildBalconyPosts, buildExitStairs } from './balcony';
import type { Fixture, Gives, StreetSite } from './fixture';
import { exitDoor, type Door } from './shell';

// Down to the street, which is the bottom floor's: its exit door and the steps down from it, the posts
// under its balcony, the garage under it and the street out front. On a floor above it, all of it is
// that many storeys further down (see Office.setLevel).
//
// The street and everything out along it (the neighbours, the golf course, the scenic loop, the
// campus's other buildings) is the world's, not the building's: it's built where it stands round the
// office's own building on the main street, and drawn that far off when you're in another building
// (see Grounds). The door, the steps, the garage and its cars are the building's own, wherever it is.

declare module '../types' {
  interface OfficeHandles {
    grounds: Grounds;
  }
}

/** The world round the building you're in. */
export interface Grounds {
  /** The building you're in stands at (x, z) in the world (the office's own is at 0, 0): the world's drawn round it. */
  setOffset(x: number, z: number): void;
  /** Where the building you're in stands (see setOffset): your floor's cars drive where it is. */
  offset(): { x: number; z: number };
}

/** The parts of the street that are the world's (see the note above): built where they stand, and moved off as one. */
const WORLD = new WeakSet<object>();
export function inWorld<F extends (site: StreetSite) => unknown>(part: F): F {
  WORLD.add(part);
  return part;
}

/**
 * The fixtures down on the street, in order: first the exit door, the steps and the garage, then each
 * of `parts`, built into the street (see StreetSite), and last the street goes in under the floor.
 */
export function downstairs<P extends Fixture<never, StreetSite>[]>(...parts: P): (Fixture | Fixture<'grounds'> | Fixture<Gives<P[number]>>)[] {
  let street: StreetSite;
  let world: StreetSite;
  let exit: { group: THREE.Group; door: Door };
  /** The world's lamps, where they stand round the office's own building. */
  const lamps: { lamp: Lamp; x: number; z: number }[] = [];
  /** The exit door and the steps down from it, the posts under the balcony, and the garage. */
  const down: Fixture = (site) => {
    const ground = new THREE.Group();
    const groundColliders: Collider[] = [];
    street = { ...site, ground, groundColliders };
    world = { ...site, ground: new THREE.Group(), groundColliders: [] };
    ground.add(world.ground);
    exit = exitDoor(site.get('night'));
    ground.add(exit.group);
    site.doors.push(exit.door);
    const stairs = new THREE.Group();
    buildExitStairs(stairs, groundColliders);
    buildBalconyPosts(stairs, groundColliders);
    ground.add(mergeByMaterial(stairs));
    // The door, its frame and the EXIT sign over it.
    site.wall(EXIT_DOOR.wall, EXIT_DOOR.u, (EXIT_DOOR.y1 + 0.7) / 2, EXIT_DOOR.width + 0.3, EXIT_DOOR.y1 + 0.7);
    buildGarage(ground, groundColliders);
    return {};
  };
  /** One of the parts: into the building's street, or the world's (keeping its lamps, to move with it). */
  const build = (part: P[number]) =>
    ((() => {
      if (!WORLD.has(part)) return part(street);
      const night = world.get('night');
      const before = night.lamps.length;
      const built = part(world);
      for (const lamp of night.lamps.slice(before)) if (lamp.ground) lamps.push({ lamp, x: lamp.x, z: lamp.z });
      return built;
    }) as Fixture<Gives<P[number]>>);
  /** The street, with everything down there, in under the floor: that many storeys further down on a floor above the bottom one. */
  const under: Fixture<'grounds'> = (site) => {
    const { ground, groundColliders } = street;
    const night = site.get('night');
    site.group.add(ground);
    site.colliders.push(...groundColliders, ...world.groundColliders);
    const base = [...groundColliders, ...world.groundColliders].map((c) => ({ c, top: c.top, bottom: c.bottom ?? 0 }));
    const placed = world.groundColliders.map((c) => ({ c, minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ }));
    let off = { x: 0, z: 0 };
    const grounds: Grounds = {
      setOffset(x, z) {
        if (x === off.x && z === off.z) return;
        off = { x, z };
        world.ground.position.set(-x, 0, -z);
        for (const p of placed) Object.assign(p.c, { minX: p.minX - x, maxX: p.maxX - x, minZ: p.minZ - z, maxZ: p.maxZ - z });
        for (const l of lamps) Object.assign(l.lamp, { x: l.x - x, z: l.z - z });
        // The sky puts its pools of light, and the halos round the street's lamps, where they are now (see Sky.placeLamps).
        night.shift = { x, z };
        night.street += 1e-6;
      },
      offset: () => off,
    };
    return {
      handle: { grounds },
      setLevel: (index) => {
        const drop = index * STOREY;
        ground.position.y = -drop;
        for (const g of base) {
          // Walls up into the sky stay that way.
          if (g.top <= 50) g.c.top = g.top - drop;
          g.c.bottom = g.bottom - drop;
        }
        night.street = streetBelow(index);
        exit.door.y = -drop;
        exit.door.locked = index > 0;
      },
    };
  };
  // Each part gives the office what it gives it.
  return [down, ...parts.map(build), under];
}
