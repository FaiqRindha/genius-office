// The campus: your ID card at a building's reader, and who's on your building's guest list.
import { READER, TAP_REACH, buildingAt } from '../../../shared/campus.js';
import { STOREY } from '../../../shared/layout.js';
import type { CampusClientMsg } from '../../../shared/protocol.js';
import { ROOF } from '../../../shared/rooftop.js';
import type { Ctx } from '../../office/context.js';
import { str } from '../../office/input.js';
import type { HandlerMap } from './types.js';

/** Every floor and floor on its way, for the campus to sort into buildings; and the open ones, bottom first. */
const defsOf = (ctx: Ctx) => [...ctx.building.list(), ...ctx.building.pending()];
const openOf = (ctx: Ctx) => [...ctx.floors.values()].map((f) => f.def);

/** Leeway on the reader's reach, for where the office last heard you were. */
const SLACK = 1.8;

export const campusHandlers = {
  'campus.tap'(ctx, c, msg) {
    const id = str(msg.building, 64);
    const state = ctx.campus.state(c, ctx.hereOf(c), defsOf(ctx), openOf(ctx));
    const slot = state.buildings.findIndex((b) => b.id === id);
    const b = state.buildings[slot];
    if (!b || !c.peer.floor || c.peer.floor === ROOF) return;
    // Where its reader is, on the map of the floor you're on: every building stands where the campus
    // has it, and yours is drawn where it always is.
    const at = buildingAt(slot);
    const home = buildingAt(state.buildings.findIndex((x) => x.id === state.here));
    const reader = { x: at.x - home.x + READER.x, z: at.z - home.z + READER.z };
    if (Math.hypot(c.peer.x - reader.x, c.peer.z - reader.z) > TAP_REACH + SLACK) return;
    // And down on the street, not up on a floor above it.
    const [, up] = state.floors[c.peer.floor] ?? ['', 0];
    if (c.peer.y > -up * STOREY - 1) return;
    const tapped = (ok: boolean, text: string, floor?: string) => ctx.sendTo(c, { t: 'campus.tapped', building: id, ok, text, ...(floor ? { floor } : {}) });
    if (!b.access) return tapped(false, `Access denied: ask ${b.name} to put you on their guest list`);
    const whose = b.mine ? 'your building' : `${b.name}'s building`;
    if (!b.bottom) {
      if (!b.mine) return tapped(false, `${b.name}'s building has no floors yet`);
      // Your own, empty: in to its lobby, where the elevator asks for its first project.
      ctx.toLobby(c, id);
      return tapped(true, 'Welcome to your building: pick its first project in the elevator');
    }
    // Its door opens for you: walk in (floor.go, which checks your card again).
    tapped(true, `Welcome to ${whose}: the door's open`, b.bottom);
  },
  'campus.invite'(ctx, c, msg) {
    if (!c.accountId) return ctx.warn(c, 'Only people with an account have a building to invite anyone into');
    const r = ctx.campus.invite(c.accountId, str(msg.account, 64));
    if (typeof r === 'string') return ctx.warn(c, r);
    for (const o of ctx.clients.values()) {
      if (o.accountId === msg.account) ctx.sendTo(o, { t: 'toast', text: `🪪 ${c.peer.name} put you on their building's guest list: your card opens its door now`, level: 'info' });
    }
    ctx.sendTo(c, { t: 'toast', text: `🪪 ${r.name}'s card opens your building's door now`, level: 'info' });
    ctx.floorsChanged();
  },
  'campus.uninvite'(ctx, c, msg) {
    if (!c.accountId) return;
    const r = ctx.campus.uninvite(c.accountId, str(msg.account, 64));
    if (typeof r === 'string') return ctx.warn(c, r);
    ctx.sendTo(c, { t: 'toast', text: `🪪 ${r.name} is off your guest list`, level: 'info' });
    // Anyone on their way out is shown the door: off its floors, to their own building.
    for (const o of ctx.clients.values()) {
      if (o.accountId !== msg.account || ctx.hereOf(o) !== c.accountId || ctx.campus.mayEnter(o, c.accountId)) continue;
      const home = ctx.arrivalFloor(null, o);
      if (home && o.peer.floor !== ROOF) ctx.goToFloor(o, home);
      else if (o.peer.floor !== ROOF) ctx.toLobby(o, o.accountId);
      ctx.sendTo(o, { t: 'toast', text: `🪪 ${c.peer.name} took you off their building's guest list`, level: 'warn' });
    }
    ctx.floorsChanged();
  },
} satisfies HandlerMap<CampusClientMsg>;
