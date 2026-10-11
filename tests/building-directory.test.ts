import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BuildingDirectory } from '../src/server/building-directory.js';
function fresh(t: { after(fn: () => void): void }) { const dir = mkdtempSync(path.join(tmpdir(), 'campus-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new BuildingDirectory(dir); }
test('creates one private persistent building per account', (t) => { const d = fresh(t), b = d.ensurePrivate('ada', 'Ada'); assert.equal(d.ensurePrivate('ada', 'Other').id, b.id); assert.equal(d.access(b.id, 'ada'), 'granted'); assert.equal(d.access(b.id), 'locked'); assert.ok(existsSync(b.dataDir)); assert.ok(existsSync(b.workspaceDir)); assert.equal(b.template, 'office'); });
test('denies discovery and access after immediate removal', (t) => { const d = fresh(t), b = d.ensurePrivate('owner', 'Owner'); assert.equal(d.visibleTo('other').length, 0); assert.equal(d.addMember(b.id, 'owner', 'other', 'member'), undefined); assert.equal(d.access(b.id, 'other'), 'granted'); assert.equal(d.removeMember(b.id, 'owner', 'other'), undefined); assert.equal(d.access(b.id, 'other'), 'denied'); });
test('registers legacy data without moving it', (t) => { const d = fresh(t), legacy = d.migrateLegacy('admin', 'Admin'); assert.equal(legacy.id, 'default'); assert.equal(legacy.dataDir, (d as unknown as { legacyDataDir: string }).legacyDataDir); });
