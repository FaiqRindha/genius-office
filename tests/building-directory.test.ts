import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BuildingDirectory } from '../src/server/building-directory.js';
function makeDirectory(t: { after(fn: () => void): void }) { const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-office-campus-')); t.after(() => rmSync(dataDir, { recursive: true, force: true })); return { dataDir, directory: new BuildingDirectory(dataDir) }; }
test('a named account receives one persistent private building with isolated directories', (t) => {
  const { dataDir, directory } = makeDirectory(t), first = directory.ensurePrivate('ada', 'Ada Lovelace');
  assert.equal(directory.ensurePrivate('ada', 'Changed name').id, first.id); assert.equal(directory.access(first.id, 'ada'), 'granted'); assert.equal(directory.access(first.id, undefined), 'locked');
  assert.ok(existsSync(first.dataDir)); assert.ok(existsSync(first.workspaceDir)); assert.equal(new BuildingDirectory(dataDir).get(first.id)?.ownerId, 'ada');
});
test('membership is enforced immediately and audited', (t) => {
  const { directory } = makeDirectory(t), building = directory.ensurePrivate('owner', 'Owner');
  assert.equal(directory.access(building.id, 'guest'), 'denied'); assert.equal(directory.addMember(building.id, 'guest', 'member', 'member'), 'Only an owner or building admin can manage members');
  assert.equal(directory.addMember(building.id, 'owner', 'member', 'member'), undefined); assert.equal(directory.access(building.id, 'member'), 'granted'); assert.equal(directory.removeMember(building.id, 'owner', 'member'), undefined); assert.equal(directory.access(building.id, 'member'), 'denied');
  assert.deepEqual(directory.activity(building.id).map((entry) => entry.action), ['member.removed', 'member.added', 'created']);
});
test('legacy data gets one default building without moving its existing checkout', (t) => {
  const { dataDir, directory } = makeDirectory(t), legacy = directory.migrateLegacy('admin', 'Administrator');
  assert.equal(legacy.id, 'default'); assert.equal(legacy.dataDir, dataDir); assert.equal(directory.migrateLegacy('other', 'Other').ownerId, 'admin'); assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'buildings.json'), 'utf8')).version, 1);
});
