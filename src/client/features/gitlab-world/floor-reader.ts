import * as THREE from 'three';
import { ELEVATOR, FLOOR, GONG } from '../../../shared/layout';
import { mesh, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';

// A card reader on every floor of a GitLab building, on the wall beside the elevator's doors: each
// floor is a project of its own, gone onto by your own GitLab access, so E here opens the building's
// floors (with yours and the 🔒 ones, see ui.ts), as its reader at the foot of its steps does.

/** Where it hangs: on the north wall in the gap between the elevator's frame (to 9.8) and the gong's (from 10.85). */
const AT = { x: (ELEVATOR.x + ELEVATOR.width / 2 + GONG.x - GONG.width / 2) / 2, z: FLOOR.minZ + 0.06 };

export interface FloorReader {
  group: THREE.Group;
  it: Interactable;
  /** You're in GitLab building `building` (its namespace), or none: it's only up in one. */
  show(building: string | undefined): void;
}

export function floorReader(): FloorReader {
  const group = new THREE.Group();
  group.position.set(AT.x, 0, AT.z);
  // At eye height, where you'd hold your card up to it.
  group.add(mesh(new THREE.BoxGeometry(0.4, 0.56, 0.08), toon('#2b2d42'), 0, 1.45, 0.04));
  group.add(mesh(new THREE.BoxGeometry(0.28, 0.1, 0.02), toon('#5aa9e6', { emissive: '#5aa9e6' }), 0, 1.6, 0.09, false));
  group.add(mesh(new THREE.BoxGeometry(0.22, 0.15, 0.02), toon('#edf2f4'), 0, 1.4, 0.09, false));
  group.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), toon('#fca311', { emissive: '#fca311' }), 0.12, 1.24, 0.09, false));
  const it: Interactable = { kind: 'gitlabdoor', x: AT.x, z: AT.z + 0.9, y: 0, radius: 1.2 };
  group.userData.interact = it;
  group.visible = false;
  it.off = true;
  return {
    group,
    it,
    show(building) {
      group.visible = !!building;
      it.off = !building;
      it.gitlabBuilding = building;
    },
  };
}
