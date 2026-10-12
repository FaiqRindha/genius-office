import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { FloorDef } from '../building.js';
import type { Who } from '../campus.js';
import { Floor, type FloorContext } from '../floor.js';
import { ROOF } from '../../shared/rooftop.js';
import { MAIN_BUILDING, type FloorInfo, type ServerMsg } from '../../shared/protocol.js';
import type { Ctx, FloorHelpers, FloorsOpen } from './context.js';
import { SLOW_CLIENT_BYTES, type Client } from './client.js';

/** Finding floors, the elevator's list of them, and taking one off the building. */
export function floorHelpers(ctx: Ctx): FloorHelpers {
  const floorOf = (c: Client): Floor | undefined => (c.peer.floor ? ctx.floors.get(c.peer.floor) : undefined);
  /** The floor a worker sits on. Worker ids are unique across the building. */
  const workerFloor = (workerId: string): Floor | undefined => {
    for (const f of ctx.floors.values()) if (f.workers.get(workerId)) return f;
    return undefined;
  };
  /** A floor coming off the building, left out of every list from now on (see closeFloor). */
  let closing: string | undefined;
  const floorInfos = (building?: string): FloorInfo[] => {
    const inIt = (def: FloorDef) => def.id !== closing && (building === undefined || ctx.campus.of(def) === building);
    return [
      ...[...ctx.floors.values()].filter((f) => inIt(f.def)).map((f) => ({ ...f.info(), ...(ctx.building.isLocal(f.id) ? { local: true } : {}) })),
      ...ctx.building
        .pending()
        .filter(inIt)
        .map((d) => ({ id: d.id, name: d.name, repo: d.repo, dir: d.dir, palette: d.palette, addedBy: d.addedBy, addedAt: d.addedAt, cloning: true, clone: ctx.building.cloneProgress(d.id), workers: 0, busy: 0, waiting: 0, people: 0, wing: 0 })),
    ];
  };
  const hereOf = (c: Client) => ctx.campus.here(c.id, c, floorOf(c)?.def);
  // What each connection was last sent, so nobody's sent the same list twice.
  const sent = new WeakMap<Client, { floors: string; campus: string }>();
  const sendFloors = (c: Client, lists = new Map<string, FloorInfo[]>()) => {
    const here = hereOf(c);
    const floors = lists.get(here) ?? floorInfos(here);
    lists.set(here, floors);
    const campus = ctx.campus.state(c, here, [...ctx.building.list(), ...ctx.building.pending()].filter((d) => d.id !== closing));
    const was = sent.get(c);
    const now = { floors: JSON.stringify(floors), campus: JSON.stringify(campus) };
    sent.set(c, now);
    if (now.floors !== was?.floors) ctx.sendTo(c, { t: 'floors', floors });
    if (now.campus !== was?.campus) ctx.sendTo(c, { t: 'campus', state: campus });
  };
  /** `c`'s building's floors, for its welcome: counted as sent. */
  const floorsFor = (c: Client): FloorInfo[] => {
    const floors = floorInfos(hereOf(c));
    sent.set(c, { floors: JSON.stringify(floors), campus: sent.get(c)?.campus ?? '' });
    return floors;
  };
  /** Everyone's lists, each of their own building. */
  const sendAll = () => {
    const lists = new Map<string, FloorInfo[]>();
    for (const c of ctx.clients.values()) if (!c.out) sendFloors(c, lists);
  };
  // The elevator's counts change with every worker update; tell everyone at most a few times a second.
  let floorsTimer: NodeJS.Timeout | undefined;
  const floorsChanged = () => {
    floorsTimer ??= setTimeout(() => {
      floorsTimer = undefined;
      sendAll();
    }, 250);
  };
  const arrivalFloor = (wanted: string | null, who: Who, except?: Floor): Floor | undefined => {
    const open = [...ctx.floors.values()].filter((f) => f !== except && ctx.campus.mayEnter(who, ctx.campus.of(f.def)));
    const inside = (b: string) => open.filter((f) => ctx.campus.of(f.def) === b);
    // Someone with an account comes in at home: their own building, or its lobby while it has no
    // floors yet (the elevator asks for its first). Anyone else's is a walk and a card away.
    const own = who.accountId && ctx.accounts.get(who.accountId) ? who.accountId : undefined;
    if (own) return inside(own).find((f) => f.id === wanted) ?? inside(own)[0];
    return open.find((f) => f.id === wanted) ?? inside(MAIN_BUILDING)[0] ?? open[0];
  };

  /**
   * Takes `floor` off the building (already out of floors.json): everyone on it rides the elevator to
   * another floor of the same building, or out to its lobby if it was the last, and its workers stop.
   */
  const closeFloor = (floor: Floor, who: string) => {
    const name = floor.def.name;
    const building = ctx.campus.of(floor.def);
    // The lists without it first, so nobody arrives somewhere (the lobby's panel) that still shows it.
    closing = floor.id;
    sendAll();
    const next = [...ctx.floors.values()].find((f) => f !== floor && ctx.campus.of(f.def) === building);
    // The roof stays up as long as there's a floor anywhere under it.
    const roofless = ![...ctx.floors.values()].some((f) => f !== floor);
    for (const c of ctx.clients.values()) {
      if (c.peer.floor === floor.id || (roofless && c.peer.floor === ROOF)) {
        if (next) ctx.goToFloor(c, next);
        else ctx.toLobby(c);
        ctx.sendTo(c, { t: 'toast', text: next ? `🛗 ${who} took ${name} off the building, so you rode the elevator to ${next.def.name}` : `🛗 ${who} took ${name}, the last floor, off the building`, level: 'warn' });
      } else if (hereOf(c) === building) ctx.sendTo(c, { t: 'toast', text: `🛗 ${who} took ${name} off the building`, level: 'info' });
    }
    ctx.floors.delete(floor.id);
    closing = undefined;
    floor.shutdown();
    floorsChanged();
    // Its workers made room under the worker limit.
    ctx.pumpQueues();
  };

  return { floorOf, workerFloor, floorInfos, floorsChanged, cancelFloorsChanged: () => clearTimeout(floorsTimer), arrivalFloor, hereOf, floorsFor, sendFloors: (c) => sendFloors(c), closeFloor };
}

/**
 * Opens every floor of the building, with what they need of the office (see FloorContext), and waits
 * until the workers still running from the last office are back at their desks.
 */
export async function openFloors(ctx: Ctx, hookPort: number): Promise<FloorsOpen> {
  const { cfg, floors, clients } = ctx;
  const floorContext: FloorContext = {
    agentCmd: cfg.agentCmd,
    agentArgs: cfg.agentArgs,
    dshProfile: cfg.dshProfile,
    hook: { url: `http://127.0.0.1:${hookPort}`, token: '' },
    ledger: ctx.ledger,
    capacity: ctx.machine,
    prompts: ctx.prompts,
    emit: ctx.toFloor,
    toast: ctx.toastFloor,
    termData: (workerId, data, viewers) => {
      const json = JSON.stringify({ t: 'term.data', workerId, data } satisfies ServerMsg);
      for (const id of viewers) {
        const c = clients.get(id);
        if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
        // A viewer on a slow link skips output and gets a fresh snapshot once it catches up,
        // instead of queueing unbounded data in server memory.
        if (c.stale.has(workerId) || c.ws.bufferedAmount > SLOW_CLIENT_BYTES) c.stale.add(workerId);
        else c.ws.send(json);
      }
    },
    changes: (state, ids) => {
      for (const id of ids) {
        const c = clients.get(id);
        if (c) ctx.sendTo(c, { t: 'changes', state });
      }
    },
    workerChanged: (floor, w) => {
      if (typeof w === 'string') {
        ctx.webhook.onWorkerGone(w);
        ctx.pumpQueues(floor);
      } else ctx.webhook.onWorker(w);
      ctx.machine.workersChanged();
      ctx.floorsChanged();
    },
    people: (floor) => {
      let n = 0;
      for (const c of clients.values()) if (c.peer.floor === floor.id) n++;
      return n;
    },
    peers: (floor) => [...clients.values()].filter((c) => c.peer.floor === floor.id).map((c) => c.peer),
    leaveOnMerge: () => ctx.leaveOnMerge.on,
    floor: (id) => floors.get(id),
    pullsChanged: (floor) => {
      for (const f of floors.values()) if (f !== floor && worksIn(f, floor)) f.sendLandedHome();
    },
    lent: (floor) => [...floors.values()].some((f) => f !== floor && worksIn(f, floor)),
    locksUp: () => !!ctx.maps.plan().sendHome?.keeps,
    runAs: ctx.signins,
    ghAs: (owner) => (owner ? ctx.signins.ghAs(owner) : undefined),
  };
  /** Whether a worker on `from` works in `on`'s project too (see WorkerInfo.repos). */
  const worksIn = (from: Floor, on: Floor) => from.workers.list().some((w) => w.repos?.some((r) => r.floor === on.id));
  const openFloor = (def: FloorDef): Floor | undefined => {
    if (!existsSync(def.dir)) {
      console.error(`agent-office: the ${def.name} floor's checkout is gone (${def.dir}) — it stays closed until it's back`);
      return undefined;
    }
    try {
      const floor = new Floor(def, floorContext);
      floors.set(def.id, floor);
      return floor;
    } catch (err) {
      console.error(`agent-office: couldn't open the ${def.name} floor: ${(err as Error).message}`);
      return undefined;
    }
  };
  // Started in a project: it's a floor too (the one it has always been).
  if (cfg.project) ctx.building.ensureLocal(cfg.project, 'the office');
  for (const def of ctx.building.list()) openFloor(def);
  // Clones keep the elevator's progress up to date, and ones the last office left running carry on.
  ctx.building.watchClones(ctx.floorsChanged);
  ctx.building.resumeClones((r) => {
    ctx.floorsChanged();
    if (typeof r === 'string') {
      console.error(`agent-office: ${r}`);
      return ctx.toastAll(`🛗 ${r}`, 'warn');
    }
    if (!openFloor(r)) return;
    console.log(`  the ${r.name} floor's clone finished (${r.dir})`);
    ctx.toastAll(`🛗 New floor: ${r.name}, added by ${r.addedBy}`);
  });
  // Workers still running from the last office are back at their desks before anyone walks in.
  await Promise.all([...floors.values()].map((f) => f.ready));
  return { openFloor };
}
