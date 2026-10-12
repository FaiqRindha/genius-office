import './map.css';
import { AVENUE, BOULEVARD, DISTRICT, FOOTPRINT, READER, buildingAt, districtEnd, slotAt } from '../../../shared/campus';
import { EXIT_STAIRS, ROAD } from '../../../shared/layout';
import type { CampusState } from '../../../shared/protocol';
import { h, openModal } from '../../ui/dom';

// The 🗺️ map: the city from above, north up, as a game's map is. The office's own building is on the
// main street; everyone's stands in its slot in the district north of it, with its owner's name and
// whether your card opens it. You're the red arrow, and everyone else you could see is a dot. The
// minimap in the corner follows you about; the whole map opens from it (or J).

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

/** The map's extent, in the world's metres: north is -z. */
export interface MapBounds {
  west: number;
  north: number;
  east: number;
  south: number;
}

/**
 * Something else in the world, on the map too (the GitLab Quarter, say): how far it reaches, so the
 * map takes it in (null: nothing to show), and drawing it, under you and everyone else.
 */
export interface MapLayer {
  bounds(): MapBounds | null;
  draw(svg: SVGSVGElement, el: (tag: string, attrs: Record<string, string | number>, text?: string) => SVGElement): void;
}

const layers: MapLayer[] = [];
const changed = new Set<() => void>();

/** Puts `layer` on the map (a feature's install does, once). */
export function addMapLayer(layer: MapLayer) {
  layers.push(layer);
  mapChanged();
}

/** A layer changed: the minimap draws itself again (the whole map does whenever it opens). */
export function mapChanged() {
  for (const fn of changed) fn();
}

/** `fn` hears when a layer changes (see mapChanged). */
export function onMapChanged(fn: () => void): () => void {
  changed.add(fn);
  return () => changed.delete(fn);
}

/** A drawn map: its picture, the whole of the campus's bounds, and moving you and the others about on it. */
export interface CampusMap {
  svg: SVGSVGElement;
  bounds: MapBounds;
  move(you: MapDot | null, others: readonly MapDot[]): void;
}

/** Draws the campus: the main street, the building you're in, the district's buildings; then you, and everyone else. */
export function campusMap(state: CampusState): CampusMap {
  const n = state.buildings.length;
  let west = Math.min(slotAt(0).x + FOOTPRINT.minX - 14, -80);
  let east = -west;
  let north = Math.min(districtEnd(Math.max(n, 1)), -60) - 6;
  let south = ROAD.maxZ + 14;
  // Taking in whatever else is on the map.
  for (const l of layers) {
    const b = l.bounds();
    if (!b) continue;
    west = Math.min(west, b.west);
    east = Math.max(east, b.east);
    north = Math.min(north, b.north);
    south = Math.max(south, b.south);
  }
  const svg = el('svg', { viewBox: `${west} ${north} ${east - west} ${south - north}`, class: 'campus-map', role: 'img', 'aria-label': 'Map of the campus' }) as SVGSVGElement;
  const rect = (x: number, z: number, w: number, d: number, cls: string) => svg.append(el('rect', { x, y: z, width: w, height: d, class: cls }));
  const label = (x: number, z: number, text: string, cls = 'cm-label') => svg.append(el('text', { x, y: z, class: cls, 'text-anchor': 'middle' }, text));

  rect(west, north, east - west, south - north, 'cm-lawn');
  // The main street, the brick path and boulevard up to the district, and the avenues in front of its rows.
  rect(west, ROAD.minZ, east - west, ROAD.maxZ - ROAD.minZ, 'cm-road');
  label(west + 30, ROAD.maxZ - 2.2, 'Main street', 'cm-road-label');
  const rows = Math.ceil((n - 1) / DISTRICT.cols);
  if (n > 1) {
    for (let r = 0; r < rows; r++) rect(west, slotAt(r * DISTRICT.cols).z + AVENUE.ahead - AVENUE.width / 2, east - west, AVENUE.width, 'cm-road');
    const top = slotAt(0).z + AVENUE.ahead;
    rect(BOULEVARD.x - BOULEVARD.width / 2, top, BOULEVARD.width, BOULEVARD.fromZ - top, 'cm-brick');
    rect(BOULEVARD.x, READER.z, EXIT_STAIRS.minX - BOULEVARD.x, 2, 'cm-brick');
  }

  const w = FOOTPRINT.maxX - FOOTPRINT.minX;
  const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
  state.buildings.forEach((b, i) => {
    const at = buildingAt(i);
    const here = b.id === state.here;
    rect(at.x + FOOTPRINT.minX, at.z + FOOTPRINT.minZ, w, d, here ? 'cm-here' : b.mine ? 'cm-mine' : b.access ? 'cm-open' : 'cm-locked');
    label(at.x, at.z - 1, `${b.access ? '🏢' : '🔒'} ${b.mine ? `${b.name} (yours)` : b.name}`, here ? 'cm-label cm-big' : 'cm-label');
    label(at.x, at.z + 6, here ? 'you’re in this one' : b.floors ? `${b.floors} floor${b.floors === 1 ? '' : 's'}` : 'no floors yet', 'cm-sub');
    svg.append(el('circle', { cx: at.x + READER.x, cy: at.z + READER.z, r: 1.4, class: 'cm-reader' }));
  });

  for (const l of layers) l.draw(svg, el);

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
      h('span.grow', {}, here ? `You’re in ${here.mine ? 'your building' : `${here.name}’s building`}, on the main street. Every project on your GitLab stands in the GitLab Quarter north of it, a building a group: drive up the road off the main street west of the office, and go in at a building’s door. ● is a card reader, at the foot of a building’s steps.` : 'The campus, from above.'),
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
