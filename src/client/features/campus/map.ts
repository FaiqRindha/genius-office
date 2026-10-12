import './map.css';
import { AVENUE, BOULEVARD, DISTRICT, FOOTPRINT, HOME_READER, READER, districtEnd, slotAt } from '../../../shared/campus';
import { EXIT_STAIRS, ROAD } from '../../../shared/layout';
import type { CampusState } from '../../../shared/protocol';
import { h, openModal } from '../../ui/dom';

// The 🗺️ map: the city from above, north up, as a game's map is. The building you're in is the one on
// the main street; every other one stands in its slot in the district north of it, with its owner's
// name and whether your card opens it. You're the red arrow, and the others out on your floor's
// grounds are dots. The minimap in the corner follows you about; the whole map opens from it (or J).

const SVG = 'http://www.w3.org/2000/svg';

function el(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Someone on the map: where they stand on the office's grounds, and (you) which way they face (0 is +z). */
export interface MapDot {
  x: number;
  z: number;
  facing?: number;
  name?: string;
}

/** A drawn map: its picture, the whole of the campus's bounds, and moving you and the others about on it. */
export interface CampusMap {
  svg: SVGSVGElement;
  bounds: { west: number; north: number; east: number; south: number };
  move(you: MapDot | null, others: readonly MapDot[]): void;
}

/** Draws the campus: the main street, the building you're in, the district's buildings; then you, and everyone else. */
export function campusMap(state: CampusState): CampusMap {
  const n = state.buildings.length;
  const west = Math.min(slotAt(0).x + FOOTPRINT.minX - 14, -80);
  const east = -west;
  const north = Math.min(districtEnd(Math.max(n, 1)), -60) - 6;
  const south = ROAD.maxZ + 14;
  const svg = el('svg', { viewBox: `${west} ${north} ${east - west} ${south - north}`, class: 'campus-map', role: 'img', 'aria-label': 'Map of the campus' }) as SVGSVGElement;
  const rect = (x: number, z: number, w: number, d: number, cls: string) => svg.append(el('rect', { x, y: z, width: w, height: d, class: cls }));
  const label = (x: number, z: number, text: string, cls = 'cm-label') => svg.append(el('text', { x, y: z, class: cls, 'text-anchor': 'middle' }, text));

  rect(west, north, east - west, south - north, 'cm-lawn');
  // The main street, the brick path and boulevard up to the district, and the avenues in front of its rows.
  rect(west, ROAD.minZ, east - west, ROAD.maxZ - ROAD.minZ, 'cm-road');
  label(west + 30, ROAD.maxZ - 2.2, 'Main street', 'cm-road-label');
  const rows = Math.ceil(n / DISTRICT.cols);
  if (n > 1) {
    for (let r = 0; r < rows; r++) rect(west, slotAt(r * DISTRICT.cols).z + AVENUE.ahead - AVENUE.width / 2, east - west, AVENUE.width, 'cm-road');
    const top = slotAt(0).z + AVENUE.ahead;
    rect(BOULEVARD.x - BOULEVARD.width / 2, top, BOULEVARD.width, BOULEVARD.fromZ - top, 'cm-brick');
    rect(BOULEVARD.x, HOME_READER.z, EXIT_STAIRS.minX - BOULEVARD.x, 2, 'cm-brick');
  }

  const w = FOOTPRINT.maxX - FOOTPRINT.minX;
  const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
  const nameOf = (b: CampusState['buildings'][number]) => (b.mine ? `${b.name} (yours)` : b.name);
  const reader = (x: number, z: number) => svg.append(el('circle', { cx: x, cy: z, r: 1.4, class: 'cm-reader' }));
  const here = state.buildings.find((b) => b.id === state.here);
  // The one you're in, on the main street.
  rect(FOOTPRINT.minX, FOOTPRINT.minZ, w, d, 'cm-here');
  label(0, -2, `🏢 ${here ? nameOf(here) : 'The office'}`, 'cm-label cm-big');
  label(0, 5, 'you’re in this one', 'cm-sub');
  reader(HOME_READER.x, HOME_READER.z);
  state.buildings.forEach((b, i) => {
    const at = slotAt(i);
    if (b.id === state.here) {
      // Its slot in the district is a plaza.
      if (n > 1) rect(at.x + FOOTPRINT.minX, at.z + FOOTPRINT.minZ, w, d, 'cm-plaza');
      if (n > 1) label(at.x, at.z + 2, '📍 on the main street', 'cm-sub');
      return;
    }
    rect(at.x + FOOTPRINT.minX, at.z + FOOTPRINT.minZ, w, d, b.mine ? 'cm-mine' : b.access ? 'cm-open' : 'cm-locked');
    label(at.x, at.z - 1, `${b.access ? '🏢' : '🔒'} ${nameOf(b)}`, 'cm-label');
    label(at.x, at.z + 6, b.floors ? `${b.floors} floor${b.floors === 1 ? '' : 's'}` : 'no floors yet', 'cm-sub');
    reader(at.x + READER.x, at.z + READER.z);
  });

  // Everyone else out on your floor's grounds, then you on top.
  const others = el('g', { class: 'cm-others' });
  const you = el('g', { class: 'cm-you' });
  you.append(el('circle', { r: 3.4, class: 'cm-you-ring' }), el('path', { d: 'M 0 6 L 3.6 -3.6 L 0 -1.4 L -3.6 -3.6 Z' }));
  svg.append(others, you);
  const dots: SVGElement[] = [];
  const move = (me: MapDot | null, rest: readonly MapDot[]) => {
    you.style.display = me ? '' : 'none';
    // Facing f, you look along (sin f, cos f): the arrow, drawn pointing +z, turns that way.
    if (me) you.setAttribute('transform', `translate(${me.x.toFixed(2)} ${me.z.toFixed(2)}) rotate(${((-(me.facing ?? 0) * 180) / Math.PI).toFixed(1)})`);
    while (dots.length < rest.length) {
      const dot = el('circle', { r: 2.2, class: 'cm-peer' });
      dot.append(el('title', {}));
      others.append(dot);
      dots.push(dot);
    }
    dots.forEach((dot, i) => {
      const p = rest[i];
      dot.style.display = p ? '' : 'none';
      if (!p) return;
      dot.setAttribute('cx', p.x.toFixed(2));
      dot.setAttribute('cy', p.z.toFixed(2));
      if (dot.firstChild) dot.firstChild.textContent = p.name ?? '';
    });
  };
  return { svg, bounds: { west, north, east, south }, move };
}

/** The whole map, in a window; `dots()` says where you and everyone else are, as it's drawn and while it's open. */
export function openCampusMap(state: () => CampusState, dots: () => { you: MapDot | null; others: MapDot[] }) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const body = h('div.body.campus-map-body');
  const s = state();
  const here = s.buildings.find((b) => b.id === s.here);
  const map = campusMap(s);
  const dialog = h(
    'div.modal.campus-map-modal',
    { role: 'dialog', 'aria-label': 'Map' },
    h('header', {}, h('h2', {}, '🗺️ Map'), close),
    body,
    h(
      'footer',
      {},
      h('span.grow', {}, here ? `You’re in ${here.mine ? 'your building' : `${here.name}’s building`}, on the main street. Every other building stands in the district: up the brick path from the foot of the exit steps. ● is a card reader.` : 'The district’s buildings, from above.'),
    ),
  );
  body.append(map.svg);
  const draw = () => {
    const d = dots();
    map.move(d.you, d.others);
  };
  draw();
  // The others keep walking while it's open.
  const timer = window.setInterval(draw, 200);
  const modal = openModal(dialog, { onClose: () => clearInterval(timer) });
  close.addEventListener('click', () => modal.close());
  return modal;
}
