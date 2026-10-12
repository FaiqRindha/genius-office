import type { Ctx } from '../../core/context';
import { store } from '../../state';
import { $, h, modalOpen } from '../../ui/dom';
import { campusMap, onMapChanged, type CampusMap, type MapDot } from './map';
import { outdoorAt, standsAt } from './where';

// The minimap, as a game has one: a round window on the map in the bottom-right corner, north up,
// that follows you about, with you as the arrow and everyone else you could see as dots.
// Click it (or J) for the whole map.

/** How many meters of the map the minimap shows either side of you. */
const SPAN = 75;
/** How often it's moved, at most (it needn't keep up with every frame). */
const EVERY_MS = 80;

/** Where you are in the world and which way you face, and everyone else on your floor or out on the grounds. */
export function dotsOf(ctx: Ctx): { you: MapDot | null; others: MapDot[] } {
  const { player } = ctx;
  if (!ctx.inOffice() || ctx.upTop()) return { you: null, others: [] };
  // The floor you're on is built round the middle of your building: the map is the world's.
  const at = standsAt(store.campus.here);
  // First person, you face where the camera looks (see place.ts: camYaw = facing - π).
  const facing = player.view === 'first' ? player.camYaw + Math.PI : player.facing;
  const others: MapDot[] = [];
  for (const p of store.peers.values()) {
    if (p.id === store.you || p.lite) continue;
    const there = store.onMyFloor(p) ? p : outdoorAt(p);
    if (there) others.push({ x: there.x + at.x, z: there.z + at.z, name: p.name });
  }
  return { you: { x: player.pos.x + at.x, z: player.pos.z + at.z, facing }, others };
}

export function mountMinimap(ctx: Ctx, open: () => void) {
  const box = h('div.minimap', { title: 'Map (J)', role: 'button', 'aria-label': 'Open the map' });
  const north = h('span.minimap-n', {}, 'N');
  const key = h('span.minimap-key', {}, '🗺️ J');
  $('hud').append(box);
  box.addEventListener('click', open);
  let map: CampusMap | null = null;
  /** When it was last moved. */
  let last = 0;
  const redraw = () => {
    map = campusMap(store.campus);
    box.replaceChildren(map.svg, north, key);
    last = 0;
  };
  store.on('campus', redraw);
  onMapChanged(redraw);
  redraw();

  ctx.ticks.add('hud', () => {
    const now = performance.now();
    if (now - last < EVERY_MS) return;
    last = now;
    const off = !ctx.inOffice() || ctx.upTop() || !store.floor || modalOpen();
    box.classList.toggle('hidden', off);
    if (off || !map) return;
    const { you, others } = dotsOf(ctx);
    if (!you) return;
    map.svg.setAttribute('viewBox', `${(you.x - SPAN).toFixed(1)} ${(you.z - SPAN).toFixed(1)} ${SPAN * 2} ${SPAN * 2}`);
    map.move(you, others);
  });
}
