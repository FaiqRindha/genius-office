import { QUARTER, QUARTER_PATH, QUARTER_ROADS, cellAt, plotAt, CELLS } from '../../../shared/gitlab-quarter';
import type { WorldState } from '../../../shared/gitlab-world';
import type { MapLayer } from '../campus/map';
import { styleOf } from './style';

// The GitLab Quarter on the 🗺️ map and the minimap (see campus/map.ts): the road up from the main
// street and its grid of avenues and streets (the ones cars drive on, see QUARTER_ROADS), each district's block with its name where its gate is, and each building
// in its colours, with its name.

/** The Quarter as `world()` has it, as a layer of the map. */
export function quarterLayer(world: () => WorldState | null): MapLayer {
  const used = () =>
    (world()?.districts ?? [])
      .flatMap((d) => d.cells)
      .filter((c) => c < CELLS);
  return {
    bounds() {
      const cells = used();
      if (!cells.length) return null;
      const cols = Math.max(...cells.map((c) => (c % QUARTER.cols) + 1));
      const rows = Math.max(...cells.map((c) => Math.floor(c / QUARTER.cols) + 1));
      return {
        west: Math.min(QUARTER.x, QUARTER_PATH.x - QUARTER_PATH.width) - 10,
        east: QUARTER.x + cols * QUARTER.cellW + 10,
        north: QUARTER.z - rows * QUARTER.cellD - 10,
        south: QUARTER_PATH.fromZ,
      };
    },
    draw(svg, el) {
      const state = world();
      const cells = used();
      if (!state || !cells.length) return;
      const g = el('g', { class: 'cm-gitlab' });
      const rect = (x: number, z: number, w: number, d: number, cls: string, fill?: string) => g.append(el('rect', { x, y: z, width: w, height: d, class: cls, ...(fill ? { fill } : {}) }));
      const label = (x: number, z: number, text: string, cls: string) => g.append(el('text', { x, y: z, class: cls, 'text-anchor': 'middle' }, text));
      // Every road (the map's edges cut off the ones out past the districts), then its name by the way up.
      for (const r of QUARTER_ROADS) rect(r.minX, r.minZ, r.maxX - r.minX, r.maxZ - r.minZ, 'cm-road');
      g.append(el('text', { x: QUARTER_PATH.x + QUARTER_PATH.width, y: QUARTER.z + 18, class: 'cm-gl-district' }, '🦊 GitLab Quarter ↑'));
      for (const d of state.districts) {
        const own = d.cells.filter((c) => c < CELLS);
        if (!own.length) continue;
        for (const c of own) {
          const at = cellAt(c);
          rect(at.x - QUARTER.cellW / 2 + 7, at.z - QUARTER.cellD / 2 + 7, QUARTER.cellW - 14, QUARTER.cellD - 14, 'cm-plaza');
        }
        for (const b of d.buildings) {
          const at = plotAt(d.cells, b.slot);
          if (!at) continue;
          const s = styleOf(b.key, b.floors.length);
          const w = s.shape === 'podium' ? s.w + 6 : s.w;
          const dd = s.shape === 'podium' ? s.d + 4 : s.d;
          rect(at.x - w / 2, at.z - dd / 2, w, dd, 'cm-gl-building', s.facade);
          // Its full name, path and projects when you point at it (the label's small at this scale).
          const live = b.floors.filter((f) => !f.archived).length;
          g.lastElementChild?.append(el('title', {}, `${b.name} · ${b.key} · ${live} project${live === 1 ? '' : 's'}`));
          label(at.x, at.z + 1.5, b.name, 'cm-gl-name');
        }
        // Its name where its gate is, on the avenue in front of its first cell (clear of its buildings).
        const first = cellAt(own[0]);
        label(first.x, first.z + QUARTER.cellD / 2 + 4, `🦊 ${d.name}`, 'cm-gl-district');
      }
      svg.append(g);
    },
  };
}
