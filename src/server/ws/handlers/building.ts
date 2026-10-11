import type { BuildingClientMsg, BuildingState } from '../../../shared/protocol.js';
import { str } from '../../office/input.js';
import type { Client } from '../../office/client.js';
import type { Ctx } from '../../office/context.js';
import type { HandlerMap } from './types.js';

function state(ctx: Ctx, accountId: string | undefined, selected?: string): BuildingState {
  const buildings = ctx.buildingDirectory.visibleTo(accountId).map((b) => ({ id: b.id, name: b.name, role: ctx.buildingDirectory.roleOf(b.id, accountId)!, access: ctx.buildingDirectory.access(b.id, accountId), createdAt: b.createdAt }));
  const chosen = selected && buildings.some((b) => b.id === selected) ? selected : undefined;
  return { ...(chosen ? { selected: chosen, activity: ctx.buildingDirectory.activity(chosen).map(({ buildingId: _buildingId, ...event }) => event) } : {}), buildings };
}

const send = (ctx: Ctx, c: Client) => ctx.sendTo(c, { t: 'building', state: state(ctx, c.accountId, c.buildingId) });

export const buildingHandlers = {
  'building.get'(ctx, c) { send(ctx, c); },
  'building.select'(ctx, c, msg) {
    const buildingId = str(msg.buildingId, 64), access = ctx.buildingDirectory.access(buildingId, c.accountId);
    ctx.sendTo(c, { t: 'building.access', buildingId, access: 'scanning' });
    if (access !== 'granted') return ctx.sendTo(c, { t: 'building.access', buildingId, access });
    c.buildingId = buildingId; ctx.sendTo(c, { t: 'building.access', buildingId, access }); send(ctx, c);
  },
  'building.member.add'(ctx, c, msg) { const error = ctx.buildingDirectory.addMember(str(msg.buildingId, 64), c.accountId ?? '', str(msg.accountId, 32), msg.role); if (error) ctx.warn(c, error); else send(ctx, c); },
  'building.member.role'(ctx, c, msg) { const error = ctx.buildingDirectory.setRole(str(msg.buildingId, 64), c.accountId ?? '', str(msg.accountId, 32), msg.role); if (error) ctx.warn(c, error); else send(ctx, c); },
  'building.member.remove'(ctx, c, msg) { const error = ctx.buildingDirectory.removeMember(str(msg.buildingId, 64), c.accountId ?? '', str(msg.accountId, 32)); if (error) ctx.warn(c, error); else send(ctx, c); },
} satisfies HandlerMap<BuildingClientMsg>;
