import { MAIN_BUILDING, type CampusState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Every building round the city, the one you're in, and your building's guest list (see shared/protocol/campus.ts). */
    campus: CampusState;
  }
  interface Topics {
    campus: true;
  }
}

export const campus: Slice = {
  init(s) {
    s.campus = { buildings: [], here: MAIN_BUILDING };
  },
  on: {
    campus(s, m) {
      s.campus = m.state;
      return ['campus'];
    },
  },
};
