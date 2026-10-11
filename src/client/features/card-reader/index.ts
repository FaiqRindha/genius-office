import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { openBuildings } from '../../ui/buildings';

declare module '../../world/types' {
  interface InteractKinds {
    cardreader: true;
  }
}

/** The 3D entrance reader is only a doorway into the same server-backed access flow as lite. */
export function installCardReader(ctx: Ctx) {
  ctx.interactions.define('cardreader', {
    reach: 2.8,
    hint: (it) => {
      const selected = it.buildingId ? store.campus.campus.find((building) => building.id === it.buildingId) : store.campus.buildings.find((building) => building.id === store.campus.selected);
      const status = selected?.access === 'granted' ? 'Access granted' : selected?.access === 'scanning' ? 'Scanning' : selected ? 'Access denied' : 'Locked';
      return { k: status, parts: [hintTitle('💳 Building ID reader'), aside(status), key('E', 'Tap ID card')] };
    },
    use: (it, key) => {
      if (key !== 'E') return;
      if (it.buildingId) ctx.net.send({ t: 'building.select', buildingId: it.buildingId });
      else openBuildings(ctx.net);
    },
  });
}
