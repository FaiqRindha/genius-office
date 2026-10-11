import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type BuildingRole = 'owner' | 'admin' | 'member' | 'visitor';
export type BuildingAccessState = 'granted' | 'denied' | 'locked' | 'scanning';
export interface BuildingMember { accountId: string; role: BuildingRole; addedAt: number; addedBy: string }
export interface BuildingRecord { id: string; name: string; ownerId: string; createdAt: number; dataDir: string; workspaceDir: string; /** Same empty office shell for every account; project data is never copied. */ template: 'office'; members: BuildingMember[] }
export interface BuildingAudit { at: number; buildingId: string; actorId: string; action: 'created' | 'member.added' | 'member.role' | 'member.removed'; accountId?: string; role?: BuildingRole }
interface Saved { version: 1; buildings: BuildingRecord[]; audit: BuildingAudit[] }

/** Persisted campus directory. Each new building has its own data and workspace roots. */
export class BuildingDirectory {
  private readonly file: string;
  private readonly root: string;
  private data: Saved = { version: 1, buildings: [], audit: [] };
  constructor(private readonly legacyDataDir: string) { this.file = path.join(legacyDataDir, 'buildings.json'); this.root = path.join(legacyDataDir, 'buildings'); this.load(); }
  get(id: string) { return this.data.buildings.find((b) => b.id === id); }
  visibleTo(accountId?: string) { return accountId ? this.data.buildings.filter((b) => this.roleOf(b.id, accountId)) : []; }
  roleOf(id: string, accountId?: string): BuildingRole | undefined { return accountId ? this.get(id)?.members.find((m) => m.accountId === accountId)?.role : undefined; }
  access(id: string, accountId?: string): BuildingAccessState { return accountId ? (this.roleOf(id, accountId) ? 'granted' : 'denied') : 'locked'; }
  ensurePrivate(accountId: string, displayName: string) { return this.data.buildings.find((b) => b.ownerId === accountId) ?? this.create(accountId, displayName); }
  migrateLegacy(ownerId: string, ownerName: string) {
    const old = this.get('default');
    if (old) {
      if (old.ownerId !== ownerId) return old;
      // The legacy office is the first administrator's building, not an extra campus building.
      if (old.name === 'Default building') { old.name = `${clean(ownerName) || 'Private'}'s building`; this.save(); }
      return old;
    }
    const now = Date.now();
    const building: BuildingRecord = { id: 'default', name: `${clean(ownerName) || 'Private'}'s building`, ownerId, createdAt: now, dataDir: this.legacyDataDir, workspaceDir: path.resolve(this.legacyDataDir, '..'), template: 'office', members: [{ accountId: ownerId, role: 'owner', addedAt: now, addedBy: ownerName }] };
    this.data.buildings.push(building); this.note(building.id, ownerId, 'created'); this.save(); return building;
  }
  addMember(id: string, actorId: string, accountId: string, role: Exclude<BuildingRole, 'owner'>): string | undefined { const b = this.manageable(id, actorId); if (typeof b === 'string') return b; if (b.members.some((m) => m.accountId === accountId)) return 'That account is already a member'; b.members.push({ accountId, role, addedAt: Date.now(), addedBy: actorId }); this.note(id, actorId, 'member.added', accountId, role); this.save(); }
  setRole(id: string, actorId: string, accountId: string, role: Exclude<BuildingRole, 'owner'>): string | undefined { const b = this.manageable(id, actorId); if (typeof b === 'string') return b; const m = b.members.find((x) => x.accountId === accountId); if (!m) return 'That account is not a member'; if (m.role === 'owner') return "The building owner can't be changed"; m.role = role; this.note(id, actorId, 'member.role', accountId, role); this.save(); }
  removeMember(id: string, actorId: string, accountId: string): string | undefined { const b = this.manageable(id, actorId); if (typeof b === 'string') return b; if (b.ownerId === accountId) return "The building owner can't be removed"; const i = b.members.findIndex((m) => m.accountId === accountId); if (i < 0) return 'That account is not a member'; b.members.splice(i, 1); this.note(id, actorId, 'member.removed', accountId); this.save(); }
  activity(id: string) { return this.data.audit.filter((event) => event.buildingId === id); }
  private create(ownerId: string, displayName: string) { const now = Date.now(), id = randomBytes(8).toString('hex'), root = path.join(this.root, id); const building: BuildingRecord = { id, name: `${clean(displayName) || 'Private'}'s building`, ownerId, createdAt: now, dataDir: path.join(root, 'data'), workspaceDir: path.join(root, 'workspace'), template: 'office', members: [{ accountId: ownerId, role: 'owner', addedAt: now, addedBy: ownerId }] }; mkdirSync(building.dataDir, { recursive: true, mode: 0o700 }); mkdirSync(building.workspaceDir, { recursive: true, mode: 0o700 }); this.data.buildings.push(building); this.note(id, ownerId, 'created'); this.save(); return building; }
  private manageable(id: string, actorId: string): BuildingRecord | string { const b = this.get(id); if (!b) return 'No such building'; const role = this.roleOf(id, actorId); return role === 'owner' || role === 'admin' ? b : 'Only a building owner or admin can manage members'; }
  private note(buildingId: string, actorId: string, action: BuildingAudit['action'], accountId?: string, role?: BuildingRole) { this.data.audit.unshift({ at: Date.now(), buildingId, actorId, action, ...(accountId ? { accountId } : {}), ...(role ? { role } : {}) }); this.data.audit.length = Math.min(this.data.audit.length, 500); }
  private load() { try { const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>; if (saved.version !== 1 || !Array.isArray(saved.buildings) || !Array.isArray(saved.audit)) throw new Error('unsupported building directory'); this.data = { version: 1, buildings: saved.buildings.map((b) => ({ ...b, template: 'office' })), audit: saved.audit }; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`agent-office: couldn't read ${this.file}: ${(err as Error).message}`); } }
  private save() { const tmp = `${this.file}.${process.pid}.tmp`; try { writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); renameSync(tmp, this.file); } catch (err) { console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`); } }
}
function clean(value: string) { return value.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 48); }
