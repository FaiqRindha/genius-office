import * as THREE from 'three';
import { DANCE_FLOOR, DJ_BOOTH, ELEVATOR, FIRE_PIT, FLOOR, ROOF_BAR, ROOF_TABLES, STAGE, WALL_HEIGHT, WALL_T } from '../../../shared/layout';
import { bulb, type NightParts } from '../../world/outside';
import { mergeByMaterial, mesh, toon } from '../../world/toon';

// A GitLab building's rooftop bar as its neighbours see it (see world.ts): every building has one, up
// over its top floor, and the one you ride up to is the whole thing (see features/rooftop). From the
// street and the other roofs it's what you'd make out from there: the deck and its glass rail, the
// DJ's stage, the bar under its pergola, the tables, the fire pit and the string lights, lit at night.
// Nothing to walk on or use, so cheap enough for every building this side of the fog.

const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;
const LIGHTS = ['#ffd166', '#ff6b9a', '#7bdff2', '#b8f2a1'];

/** Its lights, lit at night: one set for every roof (each building's would pile up in `night` as they're put up and taken down). */
const lit = new WeakMap<NightParts, Record<string, THREE.Material>>();
function light(night: NightParts, color: string, day: number): THREE.Material {
  let mats = lit.get(night);
  if (!mats) lit.set(night, (mats = {}));
  return (mats[color] ??= bulb(night, color, day));
}

/** A rooftop bar, its deck at y 0 (the top of the building's roof). */
export function roofBar(night: NightParts): THREE.Group {
  const g = new THREE.Group();
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const cx = (B.minX + B.maxX) / 2;
  const cz = (B.minZ + B.maxZ) / 2;
  g.add(mesh(new THREE.BoxGeometry(w, 0.04, d), toon('#b98a5e'), cx, 0.02, cz, false));
  g.add(mesh(new THREE.BoxGeometry(DANCE_FLOOR.maxX - DANCE_FLOOR.minX, 0.03, DANCE_FLOOR.maxZ - DANCE_FLOOR.minZ), toon('#3d405b'), (DANCE_FLOOR.minX + DANCE_FLOOR.maxX) / 2, 0.05, (DANCE_FLOOR.minZ + DANCE_FLOOR.maxZ) / 2, false));

  // Round the edge: a curb, glass, and a steel rail.
  const curb = toon('#d8d3ca');
  const steel = toon('#aeb6bf');
  const glass = new THREE.MeshBasicMaterial({ color: '#d6f1ff', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
  for (const [x0, x1, z0, z1] of [
    [B.minX, B.maxX, B.minZ, FLOOR.minZ],
    [B.minX, B.maxX, FLOOR.maxZ, B.maxZ],
    [B.minX, FLOOR.minX, B.minZ, B.maxZ],
    [FLOOR.maxX, B.maxX, B.minZ, B.maxZ],
  ] as const) {
    const alongX = x1 - x0 > z1 - z0;
    const len = alongX ? x1 - x0 : z1 - z0;
    const [ex, ez] = [(x0 + x1) / 2, (z0 + z1) / 2];
    g.add(mesh(new THREE.BoxGeometry(x1 - x0, 0.45, z1 - z0), curb, ex, 0.225, ez, false));
    const pane = mesh(new THREE.PlaneGeometry(len, 0.72), glass, ex, 0.81, ez, false);
    if (!alongX) pane.rotation.y = Math.PI / 2;
    g.add(pane);
    g.add(mesh(new THREE.BoxGeometry(alongX ? len : 0.07, 0.07, alongX ? 0.07 : len), steel, ex, 1.19, ez, false));
  }

  // The elevator's housing, with its red light on top.
  g.add(mesh(new THREE.BoxGeometry(ELEVATOR.width + 0.3, WALL_HEIGHT + 0.3, 2.4), toon('#b8c1cc'), ELEVATOR.x, (WALL_HEIGHT + 0.3) / 2, B.minZ + 1.2, false));
  g.add(mesh(new THREE.SphereGeometry(0.14, 10, 8), light(night, '#ff5d5d', 0.6), ELEVATOR.x, WALL_HEIGHT + 0.45, B.minZ + 1.2, false));

  // The DJ's stage, its table, the LED wall behind it, and its strip along the front.
  const sw = STAGE.maxX - STAGE.minX;
  const scx = (STAGE.minX + STAGE.maxX) / 2;
  g.add(mesh(new THREE.BoxGeometry(sw, STAGE.height, STAGE.maxZ - STAGE.minZ), toon('#2b2d42'), scx, STAGE.height / 2, (STAGE.minZ + STAGE.maxZ) / 2, false));
  g.add(mesh(new THREE.BoxGeometry(2.4, 0.8, 0.7), toon('#1d1e2c'), DJ_BOOTH.x, STAGE.height + 0.4, DJ_BOOTH.z + 0.75, false));
  g.add(mesh(new THREE.BoxGeometry(sw - 1, 2.2, 0.2), light(night, '#5e60ce', 0.35), scx, STAGE.height + 1.6, STAGE.minZ + 0.3, false));
  g.add(mesh(new THREE.BoxGeometry(sw, 0.06, 0.03), light(night, '#ff4fd8', 0.8), scx, STAGE.height - 0.08, STAGE.maxZ + 0.02, false));

  // The bar under its pergola.
  const bz = (ROOF_BAR.minZ + ROOF_BAR.maxZ) / 2;
  const bl = ROOF_BAR.maxZ - ROOF_BAR.minZ;
  g.add(mesh(new THREE.BoxGeometry(ROOF_BAR.depth, ROOF_BAR.height, bl), toon('#6d4c41'), ROOF_BAR.x, ROOF_BAR.height / 2, bz, false));
  g.add(mesh(new THREE.BoxGeometry(ROOF_BAR.depth + 0.2, 0.06, bl + 0.2), toon('#3e2723'), ROOF_BAR.x, ROOF_BAR.height + 0.03, bz, false));
  const wood = toon('#8d6e63');
  for (const z of [ROOF_BAR.minZ - 0.3, ROOF_BAR.maxZ + 0.3]) for (const x of [ROOF_BAR.x - 1.4, FLOOR.maxX - 0.4]) g.add(mesh(new THREE.BoxGeometry(0.14, 2.8, 0.14), wood, x, 1.4, z, false));
  for (let z = ROOF_BAR.minZ - 0.3; z <= ROOF_BAR.maxZ + 0.31; z += 1.3) g.add(mesh(new THREE.BoxGeometry(FLOOR.maxX - ROOF_BAR.x + 1.2, 0.1, 0.1), wood, (ROOF_BAR.x - 1.4 + FLOOR.maxX - 0.4) / 2, 2.8, z, false));

  // Tables with their parasols, and the fire pit.
  const top = toon('#f1faee');
  const leg = toon('#495057');
  ROOF_TABLES.forEach((t, i) => {
    g.add(mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 12), top, t.x, 0.75, t.z, false));
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 6), leg, t.x, 1.15, t.z, false));
    g.add(mesh(new THREE.ConeGeometry(1.3, 0.5, 8), toon(i % 2 ? '#e76f51' : '#2a9d8f'), t.x, 2.45, t.z, false));
  });
  g.add(mesh(new THREE.CylinderGeometry(FIRE_PIT.r, FIRE_PIT.r, 0.4, 14), toon('#6c757d'), FIRE_PIT.x, 0.2, FIRE_PIT.z, false));
  g.add(mesh(new THREE.ConeGeometry(FIRE_PIT.r * 0.5, 0.6, 8), light(night, '#ff9f1c', 0.9), FIRE_PIT.x, 0.7, FIRE_PIT.z, false));

  // String lights criss-crossing the dance floor, from the stage to the south rail.
  const bulbs = LIGHTS.map((c) => light(night, c, 0.5));
  const lamp = new THREE.SphereGeometry(0.07, 6, 4);
  let n = 0;
  for (let x = DANCE_FLOOR.minX; x <= DANCE_FLOOR.maxX + 0.01; x += 2.5) {
    for (let k = 0; k <= 8; k++) {
      const z = STAGE.maxZ + (k / 8) * (DANCE_FLOOR.maxZ + 3 - STAGE.maxZ);
      const sag = Math.sin((k / 8) * Math.PI) * 0.5;
      g.add(mesh(lamp, bulbs[n++ % bulbs.length], x, 3.2 - sag, z, false));
    }
  }
  return mergeByMaterial(g);
}
