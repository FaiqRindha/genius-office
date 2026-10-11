export type BuildingRole = 'owner' | 'admin' | 'member' | 'visitor';
export type BuildingAccess = 'granted' | 'denied' | 'locked' | 'scanning';
export interface BuildingInfo { id: string; name: string; role: BuildingRole; access: BuildingAccess; createdAt: number }
/** Publicly visible exterior only; it carries no project or membership data. */
export interface CampusBuildingInfo { id: string; name: string; access: BuildingAccess }
export interface BuildingMemberInfo { accountId: string; name: string; role: BuildingRole }
export interface BuildingActivity { at: number; actorId: string; action: 'created' | 'member.added' | 'member.role' | 'member.removed'; accountId?: string; role?: BuildingRole }
export interface BuildingState { selected?: string; buildings: BuildingInfo[]; campus: CampusBuildingInfo[]; members?: BuildingMemberInfo[]; activity?: BuildingActivity[] }
export type BuildingClientMsg =
  | { t: 'building.get' }
  | { t: 'building.select'; buildingId: string }
  | { t: 'building.leave' }
  | { t: 'building.member.add'; buildingId: string; accountId: string; role: Exclude<BuildingRole, 'owner'> }
  | { t: 'building.member.role'; buildingId: string; accountId: string; role: Exclude<BuildingRole, 'owner'> }
  | { t: 'building.member.remove'; buildingId: string; accountId: string };
export type BuildingServerMsg = { t: 'building'; state: BuildingState } | { t: 'building.access'; buildingId: string; access: BuildingAccess };
