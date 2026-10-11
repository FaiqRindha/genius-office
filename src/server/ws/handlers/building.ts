import type { BuildingClientMsg, BuildingState } from '../../../shared/protocol.js';
import { str } from '../../office/input.js';
import type { Client } from '../../office/client.js';
import type { Ctx } from '../../office/context.js';
import type { HandlerMap } from './types.js';

export function buildingState(ctx: Ctx, accountId: string | undefined, selected?: string): BuildingState {
  const buildings = ctx.buildingDirectory.visibleTo(accountId).map((b) => ({ id: b.id, name: b.name, role: ctx.buildingDirectory.roleOf(b.id, accountId)!, access: ctx.buildingDirectory.access(b.id, accountId), createdAt: b.createdAt }));
  const chosen = selected && buildings.some((b) => b.id === selected) ? selected : undefined;
  const role = chosen ? ctx.buildingDirectory.roleOf(chosen, accountId) : undefined;
  const record = chosen ? ctx.buildingDirectory.get(chosen) : undefined;
  const members = record && (role === 'owner' || role === 'admin') ? record.members.map((member) => ({ accountId: member.accountId, name: ctx.accounts.get(member.accountId)?.name ?? 'Deleted account', role: member.role })) : undefined;
  return { ...(chosen ? { selected: chosen, ...(members ? { members } : {}), activity: ctx.buildingDirectory.activity(chosen).map(({ buildingId: _buildingId, ...event }) => event) } : {}), buildings };
}

const send = (ctx: Ctx, c: Client) => ctx.sendTo(c, { t: 'building', state: buildingState(ctx, c.accountId, c.buildingId) });

export const buildingHandlers = {
  'building.get'(ctx, c) { send(ctx, c); },
  'building.select'(ctx, c, msg) {
    const buildingId = str(msg.buildingId, 64), access = ctx.buildingDirectory.access(buildingId, c.accountId);
    ctx.sendTo(c, { t: 'building.access', buildingId, access: 'scanning' });
    const error = ctx.buildingAccess.enter(buildingId, c.accountId);
    if (error) return ctx.sendTo(c, { t: 'building.access', buildingId, access });
    // Leave any old building view before replacing the building capability.  This
    // prevents a client from continuing to interact with its previously selected floor.
    ctx.toLobby(c);
    c.buildingId = buildingId;
    ctx.sendTo(c, { t: 'building.access', buildingId, access });
    ctx.sendTo(c, { t: 'floors', floors: ctx.floorInfos(buildingId) });
    send(ctx, c);
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
        ctx.warn(other, 'Your access to this building was removed');
      }
      send(ctx, other);
    }
  },
} satisfies HandlerMap<BuildingClientMsg>;
