/**
 * The campus: a building per account round the city, and the ID card reader by each one's door. E at
 * a reader taps your card: green and you're through the door onto its bottom floor, red if your card
 * doesn't open it. At your own building's, L opens its guest list.
 */
import { ENTRY } from '../../../shared/campus';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip, toast } from '../../ui/dom';
import { openGuestList } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    reader: true;
  }
}

export function installCampus(ctx: Ctx, parts: Pick<Parts, 'travel'>) {
  const world = ctx.office.campus;
  ctx.usables.add({ usable: () => world.readers });
  store.on('campus', () => world.set(store.campus));
  world.set(store.campus);

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

  // What the reader said: a beep and a green light and in through the door, or a buzz and a red one.
  ctx.messages.on('campus.tapped', (m) => {
    world.flash(m.building, m.ok);
    ctx.sound.cardReader(m.ok);
    toast(`🪪 ${m.text}`, m.ok ? 'info' : 'warn');
    if (m.ok && m.floor) setTimeout(() => parts.travel.enterAt(m.floor!, { ...ENTRY }), 450);
  });
}
