export type BuildingRole = 'owner' | 'admin' | 'member' | 'visitor';
export type BuildingAccess = 'granted' | 'denied' | 'locked' | 'scanning';
export interface BuildingInfo { id: string; name: string; role: BuildingRole; access: BuildingAccess; createdAt: number }
export interface BuildingMemberInfo { accountId: string; name: string; role: BuildingRole }
export interface BuildingActivity { at: number; actorId: string; action: 'created' | 'member.added' | 'member.role' | 'member.removed'; accountId?: string; role?: BuildingRole }
export interface BuildingState { selected?: string; buildings: BuildingInfo[]; members?: BuildingMemberInfo[]; activity?: BuildingActivity[] }
export type BuildingClientMsg =
  | { t: 'building.get' }
  | { t: 'building.select'; buildingId: string }
  | { t: 'building.member.add'; buildingId: string; accountId: string; role: Exclude<BuildingRole, 'owner'> }
  | { t: 'building.member.role'; buildingId: string; accountId: string; role: Exclude<BuildingRole, 'owner'> }
  | { t: 'building.member.remove'; buildingId: string; accountId: string };
export type BuildingServerMsg = { t: 'building'; state: BuildingState } | { t: 'building.access'; buildingId: string; access: BuildingAccess };
