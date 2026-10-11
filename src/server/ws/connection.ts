import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Session } from '../auth.js';
import type { ClientMsg } from '../../shared/protocol.js';
import { elevatorSpot } from '../../shared/layout.js';
import { lookFromSeed, sanitizeLook } from '../../shared/avatar.js';
import { ROOF } from '../../shared/rooftop.js';
import type { Ctx } from '../office/context.js';
import { newClient } from '../office/client.js';
import { COLOR_RE, spotFrom, str } from '../office/input.js';
import { floorView, roofView, screensOf } from '../office/views.js';
import { dispatch } from './dispatch.js';
import { features } from './handlers/index.js';
import { mapNews } from './handlers/settings.js';
import { buildingState } from './handlers/building.js';

/**
 * Someone came in: where they arrive and who they are, the welcome with everything they see, and
 * then whatever they send, until they leave.
 */
export function onConnection(ctx: Ctx, ws: WebSocket, url: URL, session: Session) {
  const { cfg, accounts, clients, chat, building, floors, maps, team, upgrader, ledger, webhook, machine, sky, themes, prompts, leaveOnMerge, signins } = ctx;
  const { sendTo, floorInfos, floorsChanged, arrivalFloor, meOf, accountsChanged, limitsOf } = ctx;
  const id = randomBytes(5).toString('hex');
  const account = session.account;
  // A private building is provisioned only for named accounts. The legacy office remains in place
  // and receives a default record once a named administrator can own it.
  let privateBuilding: string | undefined;
  if (account) {
    if (account.role === 'admin') ctx.buildingDirectory.migrateLegacy(account.id, account.name);
    privateBuilding = ctx.buildingDirectory.ensurePrivate(account.id, account.name).id;
  }
  // The legacy shared-password lobby stays on the migrated default floor, but it has no
  // membership capability: all mutations remain locked by BuildingAccess. Named users select
  // their own private building (or the default campus building when they are its administrator).
  const selectedBuilding = account ? (account.role === 'admin' ? 'default' : privateBuilding) : 'default';
  // A bookmarked floor is accepted only when it belongs to the member's selected building.
  const wanted = url.searchParams.get('floor');
  const wantedFloor = wanted && wanted !== ROOF ? floors.get(wanted) : undefined;
  const gone = !!wanted && wanted !== ROOF && (!wantedFloor || !ctx.buildingAccess.ownsFloor(selectedBuilding, wantedFloor.def));
  const hasFloors = floorInfos(selectedBuilding).some((item) => !item.cloning);
  const onRoof = (wanted === ROOF || gone) && hasFloors;
  const floor = onRoof ? undefined : arrivalFloor(wanted, selectedBuilding);
  const back = !gone && wanted !== null && (onRoof || floor?.id === wanted);
  const spot = (back && spotFrom(url.searchParams)) || { ...elevatorSpot(), y: 0, rotY: 0 };
  // An account's name is its own; on the shared password people pick one.
  const name = account?.name ?? (str(url.searchParams.get('name'), 24).trim() || `Guest ${id.slice(0, 3)}`);
  const colorParam = url.searchParams.get('color') ?? '';
  const intParam = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
  const me = meOf(account?.id);
  const client = newClient(id, ws, { accountId: account?.id, admin: me.admin }, {
    id,
    name,
    color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7',
    look: sanitizeLook({ skin: intParam('skin'), hair: intParam('hair'), style: intParam('style') }, lookFromSeed(id)),
    x: spot.x,
    y: spot.y,
    z: spot.z,
    // The way they were facing, or out through the elevator's doors.
    rotY: spot.rotY,
    moving: false,
    voice: false,
    muted: true,
    sharing: false,
    ...(account ? { account: true } : {}),
    ...(url.searchParams.get('lite') === '1' ? { lite: true } : {}),
    ...(onRoof ? { floor: ROOF } : floor ? { floor: floor.id } : {}),
  });
  client.buildingId = selectedBuilding;
  // Maps of your own may have been added or edited since: everyone already in hears first.
  const mapWas = maps.pick();
  if (maps.reload()) mapNews(ctx, mapWas);
  clients.set(id, client);
  if (account) accounts.seen(account.id);
  ws.on('pong', () => (client.isAlive = true));

  sendTo(client, {
    t: 'welcome',
    you: id,
    peers: [...clients.values()].filter((c) => c.buildingId === client.buildingId).map((c) => c.peer),
    floors: floorInfos(client.buildingId),
    projectsDir: building.projectsDirState(),
    ice: cfg.iceServers,
    chat: chat.recent(50),
    invites: team.available || !!cfg.tailnet,
    version: upgrader.version,
    upgrade: upgrader.state,
    usage: ledger.state(),
    limits: limitsOf(client).state,
    me,
    notify: webhook.state(),
    machine: machine.state(),
    sky: sky.state,
    theme: themes.state(),
    map: maps.state(),
    prompts: prompts.state(),
    leaveOnMerge: leaveOnMerge.state(),
    building: buildingState(ctx, account?.id, client.buildingId),
    ...(onRoof ? roofView(ctx) : floorView(ctx, floor)),
  });
  screensOf(ctx, client, floor);
  ctx.toBuilding(client.buildingId, { t: 'peer.join', peer: client.peer }, id);
  if (account) accountsChanged(); // now online
  floorsChanged();
  if (floor) {
    floor.arrived();
    // Anyone whose process ended since (exited, or failed to resume) gets up as you walk in.
    floor.workers.wakeAll();
  }
  limitsOf(client).refresh();
  if (account) {
    sendTo(client, { t: 'signins', state: signins.state(account.id) });
    void signins.look(account.id);
  }

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || client.out) return;
    dispatch(ctx, client, msg);
  });
  ws.on('close', () => {
    clients.delete(id);
    // Each feature lets go of what they had (see FeatureHooks), then of what they had on each floor.
    for (const f of features) f.closed?.(ctx, client);
    for (const floor of floors.values()) for (const f of features) f.closedOn?.(ctx, client, floor);
    ctx.toBuilding(client.buildingId, { t: 'peer.leave', id });
    if (account) accountsChanged();
    floorsChanged();
  });
  ws.on('error', () => ws.terminate());
}
