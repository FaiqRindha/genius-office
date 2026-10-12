/**
 * The campus: a building per account in one world, each where it stands, and an ID card reader at
 * the foot of each one's exit steps. E at a reader taps your card: green and its door opens for you
 * (walk up and in, and you're on its bottom floor), red if your card doesn't open it. At your own
 * building's, L opens its guest list. Its elevator, down in its garage, takes you up the same way. Out on the grounds you see everyone else out there, whichever
 * building they came out of. The minimap in the corner follows you about; J (or a click on it) opens
 * the whole map.
 */
import { ENTRY } from '../../../shared/campus';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip, toast } from '../../ui/dom';
import { openCampusMap } from './map';
import { dotsOf, mountMinimap } from './minimap';
import { openGuestList } from './ui';
import { outdoorAt, standsAt } from './where';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    reader: true;
    lift: true;
  }
}

export function installCampus(ctx: Ctx, parts: Pick<Parts, 'travel'>) {
  const { office, player } = ctx;
  const world = office.campus;
  ctx.usables.add({ usable: () => world.readers });

  /** Draws the world round the building you're in, where it stands. The cars and the golf are the main street's. */
  const apply = () => {
    const at = standsAt(store.campus.here);
    office.grounds.setOffset(at.x, at.z);
    world.set(store.campus, at);
    const away = at.x !== 0 || at.z !== 0;
    for (const it of office.interactables) if (it.kind === 'car' || it.kind === 'golf') it.off = away;
  };
  // Walking in through a door, the world moves once you're on the other side of it.
  let held = false;
  store.on('campus', () => (ctx.trip()?.at ? (held = true) : apply()));
  ctx.messages.on('floor.enter', () => {
    if (!held) return;
    held = false;
    apply();
  });
  apply();

  const buildingOf = (id?: string) => store.campus.buildings.find((b) => b.id === id);
  let tappedAt = 0;

  ctx.interactions.define('reader', {
    reach: 2.2,
    hint: (it) => {
      const b = buildingOf(it.building);
      if (!b) return { k: '', parts: [] };
      const name = b.mine ? 'Your building' : `${clip(b.name, 24)}’s building`;
      const k = `${b.id}|${b.access}|${b.mine}|${!!store.campus.guests}`;
      return {
        k,
        parts: [
          hintTitle(`🪪 ${name}`),
          aside(b.access ? (b.mine ? 'your card opens it' : 'you’re on its guest list') : 'your card won’t open it'),
          key('E', 'Tap your card'),
          ...(b.mine && store.campus.guests ? [key('L', 'Guest list')] : []),
        ],
      };
    },
    use: (it, k) => {
      const b = buildingOf(it.building);
      if (!b) return;
      if (k === 'L' && b.mine && store.campus.guests) return openGuestList(ctx.net);
      if (k !== 'E') return;
      const now = performance.now();
      if (now - tappedAt < 800) return;
      tappedAt = now;
      ctx.net.send({ t: 'campus.tap', building: b.id });
    },
  });

  // Another building's elevator, down in its garage: up to its bottom floor, if your card opens the building.
  ctx.interactions.define('lift', {
    reach: 4.5,
    hint: (it) => {
      const b = buildingOf(it.building);
      if (!b) return { k: '', parts: [] };
      const name = b.mine ? 'your building' : `${clip(b.name, 24)}’s building`;
      return {
        k: `lift|${b.id}|${b.access}|${b.bottom ?? ''}`,
        parts: [hintTitle('🛗 Elevator'), aside(b.access ? `Garage · up into ${name}` : `${name} · your card won’t call it`), ...(b.access && b.bottom ? [key('E', 'Ride up')] : [])],
      };
    },
    use: (it, k) => {
      const b = buildingOf(it.building);
      if (k !== 'E' || !b) return;
      if (!b.access || !b.bottom) {
        ctx.sound.cardReader(false);
        toast(b.access ? `🛗 ${b.name}’s building has no floors yet` : `🪪 Access denied: ask ${b.name} to put you on their guest list`, 'warn');
        return;
      }
      parts.travel.ride(b.bottom);
    },
  });

  // Up the steps and through a door your card opened: you're in, on its bottom floor, where you were.
  ctx.ticks.add('moved', () => {
    if (ctx.trip() || !ctx.inOffice() || ctx.upTop()) return;
    const p = player.pos;
    const id = world.walkingInto(p.x, p.y, p.z);
    const b = id ? buildingOf(id) : undefined;
    if (!b?.bottom) return;
    const from = standsAt(store.campus.here);
    const to = standsAt(b.id);
    parts.travel.walkInto(b.bottom, { x: ENTRY.x, y: 0, z: p.z + from.z - to.z, rotY: player.facing });
  });

  // The map: the whole of it with J (or a click on the minimap in the corner).
  const showMap = () => {
    if (!ctx.inOffice()) toast('🗺️ The map is of the office’s city: this building’s on a map of its own', 'warn');
    else openCampusMap(() => store.campus, () => dotsOf(ctx));
  };
  mountMinimap(ctx, showMap);
  ctx.keys.bind({ code: 'KeyJ', run: () => showMap() });

  // What the reader said: a beep and a green light and its door opens, or a buzz and a red one.
  ctx.messages.on('campus.tapped', (m) => {
    world.flash(m.building, m.ok);
    ctx.sound.cardReader(m.ok);
    toast(`🪪 ${m.text}`, m.ok ? 'info' : 'warn');
    if (m.ok) world.unlock(m.building);
  });

  return { showMap, outdoorAt };
}
