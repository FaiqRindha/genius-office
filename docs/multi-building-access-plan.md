# Multi-Building Access Plan

## Goal

Turn one shared Agent Office into a secure campus of separate buildings. Every new Office account receives its own building. A person can enter another building only when its owner or an admin grants membership.

Each building has a visible ID-card reader at its entrance. The reader is an accurate representation of the server's access decision, not a client-only decoration.

## User model

| Role | Can enter | Can manage members | Can add projects and hire workers | Can remove the building |
| --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | No |
| Member | Yes | No | Yes | No |
| Visitor | Yes | No | No | No |
| No membership | No | No | No | No |

- Creating or first signing in to an Office account creates one private building owned by that account.
- An account may belong to more than one building.
- Existing shared-password sessions do not receive private-building access. An administrator must use a named Office account.

## Data and isolation

1. Add a `BuildingDirectory` server module, persisted as `.agent-office/buildings.json`.
2. Give every building a stable ID, name, owner, member list, creation time, and its own data/workspace directories.
3. Move floor definitions, clone records, queues, workers, decorations, and project settings underneath the building's directory.
4. Make GitHub and Claude sign-ins resolve from the member who starts work, while repository and workspace files remain scoped to the selected building.
5. Migrate the current single building into a default building owned by the initial administrator. Do not delete existing checkouts during migration.

## Server-side authorization

1. Add a `building` protocol domain for listing buildings, selecting one, requesting access, and managing membership.
2. Add `BuildingAccess` guards used before every building-scoped action: entering a building, listing repositories, cloning, viewing GitHub boards, hiring workers, using queues, and opening terminals.
3. Never rely on a client-selected building ID without checking membership on the server.
4. Return a structured access state: `granted`, `denied`, `locked`, or `scanning`.
5. Audit membership changes and deny access immediately after removal.

## Card reader experience

1. Add an entrance fixture to every building lobby: a wall-mounted card reader with the building name and lock indicator.
2. When a player approaches it, show the interaction hint: `Tap ID card`.
3. On interaction, animate the reader through `Scanning` and display one of:
   - green: `Access granted` and open the door;
   - red: `Access denied` and keep the door locked;
   - blue: `Visitor access` and open a read-only entrance;
   - gray: `Locked` when no eligible account session exists.
4. Add the same state to the 2D/lite view and building picker, so accessibility does not depend on 3D rendering.
5. Use the Office account session as the digital ID card. No biometric data is collected or processed.

## Building navigation

1. Replace the global floor picker with a campus lobby that lists only buildings visible to the signed-in account.
2. Entering a building loads only its floors, people, workers, boards, and repository choices.
3. The elevator inside a building lists only that building's projects/floors.
4. Add an owner/admin panel for invitations, role changes, removal, and an access activity log.

## GitHub behavior

1. A building's repository list uses the GitHub login of the member currently using that building, subject to their building role.
2. Private repositories remain invisible outside the building where they were added.
3. Clones, fetches, push operations, PRs, and issue actions use the member's own GitHub credentials.
4. A visitor cannot list repositories, clone a project, open a terminal, or start a worker.

## Delivery phases

### Phase 1: domain model and migration

- Implement persisted buildings and memberships.
- Create a private building for new accounts.
- Migrate the legacy shared office into a default building.
- Add server authorization tests.

### Phase 2: campus and permissions

- Add building picker, membership management, and server-enforced building selection.
- Scope existing floors, workers, queues, and GitHub data by building.
- Add end-to-end tests for cross-building denial.

### Phase 3: card reader UI

- Add the 3D fixture, interaction, animation, sounds, and status UI.
- Add equivalent 2D/lite presentation.
- Capture headless-browser screenshots for granted and denied states.

### Phase 4: hardening and release

- Test migration, account revocation, invitation expiry, concurrent access, and private-repository isolation.
- Update README and self-hosting documentation.
- Run `npm run typecheck`, `npm test`, `npm run build`, and visual screenshot checks before opening the PR.

## Acceptance criteria

- A newly created account sees a new private building by default.
- A user without membership cannot discover or enter another private building.
- A visitor can enter only when invited and cannot mutate projects or run workers.
- A member sees only the selected building's projects and GitHub data.
- The card reader's displayed state always matches the server's authorization result.
- Removing a member takes effect without restarting the office.
