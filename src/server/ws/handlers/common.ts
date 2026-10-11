// Lookups most handlers start with.
import type { Floor } from '../../floor.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';

/** The floor `c` is on, or a note to them that they have to be on one. */
export const here = (ctx: Ctx, c: Client): Floor | undefined => {
  const f = ctx.floorOf(c);
  if (!f) ctx.warn(c, 'Take the elevator to a floor first');
  return f;
};

/** A selected building role must permit mutations before a floor feature can change anything. */
export const mayMutateBuilding = (ctx: Ctx, c: Client): boolean => {
  const error = ctx.buildingAccess.mutate(c.buildingId, c.accountId);
  if (error) ctx.warn(c, error);
  return !error;
};

/** A worker by id, with the floor it sits on. */
export const workerOf = (ctx: Ctx, id: unknown) => {
  const wid = str(id, 32);
  const floor = ctx.workerFloor(wid);
  return floor ? { wid, floor, info: floor.workers.get(wid)! } : undefined;
};

/** Looks up a worker only when it belongs to the browser's selected building. */
export const workerHere = (ctx: Ctx, c: Client, id: unknown) => {
  const found = workerOf(ctx, id);
  if (found && (found.floor.def.buildingId ?? 'default') !== c.buildingId) {
    ctx.warn(c, 'That worker belongs to another building');
    return undefined;
  }
  return found;
};
