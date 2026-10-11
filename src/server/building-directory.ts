import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type BuildingRole = 'owner' | 'admin' | 'member' | 'visitor';
export type AccessState = 'granted' | 'denied' | 'locked' | 'scanning';
export interface BuildingMember { accountId: string; role: BuildingRole; addedAt: number; addedBy: string }
export interface OfficeBuilding { id: string; name: string; ownerId: string; createdAt: number; dataDir: string; workspaceDir: string; members: BuildingMember[] }
export interface BuildingAudit { at: number; actorId: string; buildingId: string; action: 'created' | 'member.added' | 'member.role' | 'member.removed'; accountId?: string; role?: BuildingRole }
interface Saved { version: 1; buildings: OfficeBuilding[]; audit: BuildingAudit[] }
const MAX_AUDIT = 500;

/** The campus directory in .agent-office/buildings.json. Legacy floors remain in place until they are scoped in phase two. */
export class BuildingDirectory {
  private file: string;
  private root: string;
  private data: Saved = { version: 1, buildings: [], audit: [] };
  constructor(private officeDataDir: string) { this.file = path.join(officeDataDir, 'buildings.json'); this.root = path.join(officeDataDir, 'buildings'); this.load(); }
  list(accountId?: string): OfficeBuilding[] { return this.data.buildings.filter((b) => !accountId || this.roleFor(b.id, accountId)); }
  get(id: string): OfficeBuilding | undefined { return this.data.buildings.find((b) => b.id === id); }
  roleFor(buildingId: string, accountId: string | undefined): BuildingRole | undefined { return accountId ? this.get(buildingId)?.members.find((m) => m.accountId === accountId)?.role : undefined; }
  access(buildingId: string, accountId: string | undefined): AccessState { return accountId ? (this.roleFor(buildingId, accountId) ? 'granted' : 'denied') : 'locked'; }
  /** Creates the one private building an account gets on its first named sign-in. */
  ensurePrivate(accountId: string, name: string): OfficeBuilding { return this.data.buildings.find((b) => b.ownerId === accountId) ?? this.create(accountId, name, name); }
  /** Creates the default record for legacy data, without moving or deleting checkouts. */
  migrateLegacy(ownerId: string, ownerName: string): OfficeBuilding {
    const existing = this.get('default'); if (existing) return existing;
    const now = Date.now();
    const building: OfficeBuilding = { id: 'default', name: 'Default building', ownerId, createdAt: now, dataDir: this.officeDataDir, workspaceDir: path.resolve(this.officeDataDir, '..'), members: [{ accountId: ownerId, role: 'owner', addedAt: now, addedBy: ownerName }] };
    this.data.buildings.push(building); this.audit(ownerId, building.id, 'created'); this.save(); return building;
  }
  addMember(buildingId: string, actorId: string, accountId: string, role: Exclude<BuildingRole, 'owner'>): string | undefined {
    const building = this.get(buildingId); if (!building) return 'No such building';
    if (!this.mayManage(building, actorId)) return 'Only an owner or building admin can manage members';
    if (building.members.some((m) => m.accountId === accountId)) return 'That account is already a member';
    building.members.push({ accountId, role, addedAt: Date.now(), addedBy: actorId }); this.audit(actorId, buildingId, 'member.added', accountId, role); this.save();
  }
  setRole(buildingId: string, actorId: string, accountId: string, role: Exclude<BuildingRole, 'owner'>): string | undefined {
    const building = this.get(buildingId); if (!building) return 'No such building';
    if (!this.mayManage(building, actorId)) return 'Only an owner or building admin can manage members';
    const member = building.members.find((m) => m.accountId === accountId); if (!member) return 'That account is not a member';
    if (member.role === 'owner') return "The building owner can't be changed here";
    member.role = role; this.audit(actorId, buildingId, 'member.role', accountId, role); this.save();
  }
  removeMember(buildingId: string, actorId: string, accountId: string): string | undefined {
    const building = this.get(buildingId); if (!building) return 'No such building';
    if (!this.mayManage(building, actorId)) return 'Only an owner or building admin can manage members';
    if (accountId === building.ownerId) return "The building owner can't be removed";
    const index = building.members.findIndex((m) => m.accountId === accountId); if (index < 0) return 'That account is not a member';
    building.members.splice(index, 1); this.audit(actorId, buildingId, 'member.removed', accountId); this.save();
  }
  activity(buildingId: string): BuildingAudit[] { return this.data.audit.filter((entry) => entry.buildingId === buildingId); }
  private create(ownerId: string, name: string, actorId: string): OfficeBuilding {
    const now = Date.now(), id = randomBytes(8).toString('hex'), root = path.join(this.root, id);
    const building: OfficeBuilding = { id, name: cleanBuildingName(name), ownerId, createdAt: now, dataDir: path.join(root, 'data'), workspaceDir: path.join(root, 'workspace'), members: [{ accountId: ownerId, role: 'owner', addedAt: now, addedBy: actorId }] };
    mkdirSync(building.dataDir, { recursive: true, mode: 0o700 }); mkdirSync(building.workspaceDir, { recursive: true, mode: 0o700 });
    this.data.buildings.push(building); this.audit(actorId, id, 'created'); this.save(); return building;
  }
  private mayManage(building: OfficeBuilding, accountId: string): boolean { const role = building.members.find((m) => m.accountId === accountId)?.role; return role === 'owner' || role === 'admin'; }
  private audit(actorId: string, buildingId: string, action: BuildingAudit['action'], accountId?: string, role?: BuildingRole) {
    this.data.audit.unshift({ at: Date.now(), actorId, buildingId, action, ...(accountId ? { accountId } : {}), ...(role ? { role } : {}) }); this.data.audit.length = Math.min(this.data.audit.length, MAX_AUDIT);
  }
  private load() {
    try { const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>; if (saved.version !== 1 || !Array.isArray(saved.buildings) || !Array.isArray(saved.audit)) throw new Error('unsupported building directory'); this.data = { version: 1, buildings: saved.buildings, audit: saved.audit }; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`agent-office: couldn't read ${this.file}: ${(err as Error).message}`); }
  }
  private save() { const tmp = `${this.file}.${process.pid}.tmp`; try { writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); renameSync(tmp, this.file); statSync(this.file); } catch (err) { console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`); } }
}
function cleanBuildingName(name: string): string { const cleaned = name.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 48); return cleaned ? `${cleaned}'s building` : 'Private building'; }
