import type { BuildingState } from '../../../shared/protocol';
import type { Slice, Store } from '../store';

declare module '../store' {
  interface Store { campus: BuildingState }
  interface Topics { campus: true }
}

export const campus: Slice = {
  init(s: Store) { s.campus = { buildings: [], campus: [] }; },
  on: {
    welcome(s, m) { s.campus = m.building; return ['campus']; },
    building(s, m) { s.campus = m.state; return ['campus']; },
    'building.access'(s, m) {
      s.campus = { ...s.campus, buildings: s.campus.buildings.map((b) => b.id === m.buildingId ? { ...b, access: m.access } : b), campus: s.campus.campus.map((b) => b.id === m.buildingId ? { ...b, access: m.access } : b) };
      return ['campus'];
    },
  },
};
