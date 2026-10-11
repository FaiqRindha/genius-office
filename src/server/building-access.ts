import type { BuildingDirectory, BuildingRole } from './building-directory.js';
import type { FloorDef } from './building.js';

/** Server-side access decision for a selected campus building. Never trust a browser-supplied id. */
export class BuildingAccess {
  constructor(private readonly directory: BuildingDirectory) {}

  role(buildingId: string | undefined, accountId: string | undefined): BuildingRole | undefined {
    return buildingId ? this.directory.roleOf(buildingId, accountId) : undefined;
  }

  enter(buildingId: string, accountId: string | undefined): string | undefined {
    const access = this.directory.access(buildingId, accountId);
    return access === 'granted' ? undefined : access === 'locked' ? 'Sign in with a named Office account to enter this building' : 'You do not have access to this building';
  }

  mutate(buildingId: string | undefined, accountId: string | undefined): string | undefined {
    // The migrated legacy building retains its shared-password behavior. It is never a route
    // into a private building: anonymous sessions cannot select or discover any other id.
    if (buildingId === 'default' && !accountId) return undefined;
    const role = this.role(buildingId, accountId);
    if (!role) return 'Select a building you can access first';
    return role === 'visitor' ? 'Visitor access is read-only' : undefined;
  }

  manage(buildingId: string | undefined, accountId: string | undefined): string | undefined {
    const role = this.role(buildingId, accountId);
    return role === 'owner' || role === 'admin' ? undefined : 'Only a building owner or admin can manage members';
  }

  ownsFloor(buildingId: string | undefined, floor: FloorDef): boolean {
    return !!buildingId && (floor.buildingId ?? 'default') === buildingId;
  }
}
