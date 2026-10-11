import type { BuildingClientMsg, BuildingState } from '../../../shared/protocol.js';
import { str } from '../../office/input.js';
import type { Client } from '../../office/client.js';
import type { Ctx } from '../../office/context.js';
import type { HandlerMap } from './types.js';

export function buildingState(ctx: Ctx, accountId: string | undefined, selected?: string): BuildingState {
  const buildings = ctx.buildingDirectory.visibleTo(accountId).map((b) => ({ id: b.id, name: b.name, role: ctx.buildingDirectory.roleOf(b.id, accountId)!, access: ctx.buildingDirectory.access(b.id, accountId), createdAt: b.createdAt }));
  // The campus exterior is public, but the picker keeps private building data undiscoverable.
  const campus = ctx.buildingDirectory.list().map((b) => ({ id: b.id, name: b.name, access: ctx.buildingDirectory.access(b.id, accountId) }));
  const chosen = selected && buildings.some((b) => b.id === selected) ? selected : undefined;
  const role = chosen ? ctx.buildingDirectory.roleOf(chosen, accountId) : undefined;
  const record = chosen ? ctx.buildingDirectory.get(chosen) : undefined;
  const members = record && (role === 'owner' || role === 'admin') ? record.members.map((member) => ({ accountId: member.accountId, name: ctx.accounts.get(member.accountId)?.name ?? 'Deleted account', role: member.role })) : undefined;
  return { ...(chosen ? { selected: chosen, ...(members ? { members } : {}), activity: ctx.buildingDirectory.activity(chosen).map(({ buildingId: _buildingId, ...event }) => event) } : {}), buildings, campus };
}

const send = (ctx: Ctx, c: Client) => ctx.sendTo(c, { t: 'building', state: buildingState(ctx, c.accountId, c.buildingId) });

export const buildingHandlers = {
  'building.get'(ctx, c) { send(ctx, c); },
  'building.select'(ctx, c, msg) {
    const buildingId = str(msg.buildingId, 64), access = ctx.buildingDirectory.access(buildingId, c.accountId);
    ctx.sendTo(c, { t: 'building.access', buildingId, access: 'scanning' });
    const error = ctx.buildingAccess.enter(buildingId, c.accountId);
    if (error) return ctx.sendTo(c, { t: 'building.access', buildingId, access });
    // Leave the old interior before entering the requested one. The campus itself remains shared.
    ctx.toLobby(c);
    c.buildingId = buildingId;
    c.peer.buildingId = buildingId;
    ctx.sendTo(c, { t: 'building.access', buildingId, access });
    ctx.sendTo(c, { t: 'floors', floors: ctx.floorInfos(buildingId) });
    send(ctx, c);
    ctx.broadcast({ t: 'peer.update', peer: c.peer });
  },
  'building.leave'(ctx, c) {
    if (!c.buildingId) return;
    ctx.toLobby(c);
    c.buildingId = undefined;
    delete c.peer.buildingId;
    ctx.sendTo(c, { t: 'floors', floors: [] });
    send(ctx, c);
    ctx.broadcast({ t: 'peer.update', peer: c.peer });
  },
  'building.member.add'(ctx, c, msg) { const error = ctx.buildingDirectory.addMember(str(msg.buildingId, 64), c.accountId ?? '', str(msg.accountId, 32), msg.role); if (error) ctx.warn(c, error); else { for (const other of ctx.clients.values()) send(ctx, other); } },
  'building.member.role'(ctx, c, msg) { const error = ctx.buildingDirectory.setRole(str(msg.buildingId, 64), c.accountId ?? '', str(msg.accountId, 32), msg.role); if (error) ctx.warn(c, error); else { for (const other of ctx.clients.values()) send(ctx, other); } },
  'building.member.remove'(ctx, c, msg) {
    const buildingId = str(msg.buildingId, 64), accountId = str(msg.accountId, 32);
    const error = ctx.buildingDirectory.removeMember(buildingId, c.accountId ?? '', accountId);
    if (error) return ctx.warn(c, error);
    // Revocation is immediate for every open tab, not merely on its next request.
    for (const other of ctx.clients.values()) {
      if (other.accountId === accountId && other.buildingId === buildingId) {
        ctx.toLobby(other);
        other.buildingId = undefined;
        delete other.peer.buildingId;
        ctx.warn(other, 'Your access to this building was removed');
        ctx.broadcast({ t: 'peer.update', peer: other.peer });
      }
      send(ctx, other);
    }
  },
} satisfies HandlerMap<BuildingClientMsg>;
