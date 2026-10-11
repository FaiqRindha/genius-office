import * as THREE from 'three';
import { store } from '../../state';
import { mesh, roundedBox, textPlane, toon, toonUnique } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

/** A small wall-mounted Office ID reader by the elevator. Its state is represented by the
 * server-authorized picker opened through the interaction, never by this model alone. */
export const cardReader: Fixture = () => {
  const group = new THREE.Group();
  // Just inside the lobby/elevator wall; it deliberately uses no account-specific text so one
  // shared office shell can represent every private building.
  group.position.set(10.7, 1.5, 9.72);
  const body = toon('#202a35');
  const trim = toon('#9ba9b5');
  const lamp = toonUnique('#9ba9b5');
  const refresh = () => {
    const access = store.campus.buildings.find((building) => building.id === store.campus.selected)?.access ?? 'locked';
    const color = access === 'granted' ? '#67d98b' : access === 'scanning' ? '#63b3ed' : access === 'denied' ? '#f26b61' : '#9ba9b5';
    lamp.color.set(color);
    lamp.emissive = new THREE.Color(color);
    lamp.emissiveIntensity = 0.8;
  };
  store.on('campus', refresh);
  refresh();
  group.add(mesh(roundedBox(0.56, 0.9, 0.13, 0.06), body, 0, 0, 0));
  group.add(mesh(roundedBox(0.42, 0.2, 0.04, 0.025), trim, 0, 0.16, 0.08));
  group.add(mesh(new THREE.CircleGeometry(0.09, 16), lamp, 0, -0.18, 0.08));
  const label = textPlane('ID', { bg: '#eaf2f8', size: 44 });
  label.scale.multiplyScalar(0.18); label.position.set(0, 0.35, 0.08); group.add(label);
  const interactable: Interactable = { kind: 'cardreader', x: 10.7, z: 8.4, radius: 1.5 };
  group.userData.interact = interactable;
  const colliders: Collider[] = [{ minX: 10.38, maxX: 11.02, minZ: 9.58, maxZ: 9.9, top: 2.45 }];
  return { group, colliders, interactables: [interactable] };
};
