import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateStudioPolicy, guardedPolicy, policyBrief } from '../studio/policy.mjs';
import { studioPermissionFlags, detectUsageLimit } from '../studio/runner.mjs';
import { StudioManager } from '../studio/manager.mjs';

const auton = {
  mode: 'autonomous', ownerAuthorized: true,
  tools: { playwright: true, blender: true, tripo: true, imagegen: true },
  tripoCreditCap: 500, tripoAttemptsPerAsset: 2,
  autoResume: true, maxRateLimitRetries: 3, retryDelayMinutes: 30,
};
test('guarded default does not enable any creative web permissions', () => {
  assert.equal(guardedPolicy().mode, 'guarded');
  const p = validateStudioPolicy();
  assert.equal(p.tripoCreditCap, 0);
  assert.ok(Object.values(p.tools).every(v => v === false));
});
test('autonomy requires explicit authorization, typed tools and bounded Tripo credits', () => {
  assert.throws(() => validateStudioPolicy({ ...auton, ownerAuthorized: false }), /owner authorization/);
  assert.throws(() => validateStudioPolicy({ ...auton, tripoCreditCap: 1600 }), /Tripo/);
  assert.throws(() => validateStudioPolicy({ ...auton, tripoAttemptsPerAsset: 3 }), /two Tripo attempts/);
  assert.throws(() => validateStudioPolicy({ ...auton, tools: { ...auton.tools, tripo: false } }), /Tripo/);
  const p = validateStudioPolicy(auton);
  assert.equal(p.mode, 'autonomous');
  assert.equal(p.tools.playwright, true);
  assert.equal(p.tripoCreditCap, 500);
  assert.match(policyBrief(p), /NOT technically|browser does not enforce/i);
});
test('autonomous CLIs use native auto permissions, never bypass', () => {
  const a = validateStudioPolicy(auton);
  assert.deepEqual(studioPermissionFlags('claude', a), ['--permission-mode','auto']);
  assert.deepEqual(studioPermissionFlags('codex', a), ['--ask-for-approval','never']);
  assert.deepEqual(studioPermissionFlags('claude', guardedPolicy()), ['--permission-mode','default']);
  assert.deepEqual(studioPermissionFlags('codex', guardedPolicy()), []);
  assert.ok(!JSON.stringify([studioPermissionFlags('claude', a),studioPermissionFlags('codex', a)]).includes('bypassPermissions'));
});
test('rate-limit classifier triggers only on nonzero explicit usage error', () => {
  assert.equal(detectUsageLimit({ code: 1, stderr: 'Error: You have hit your limit. Resets at 6pm.' }), true);
  assert.equal(detectUsageLimit({ code: 1, stderr: 'API status 429 Too Many Requests' }), true);
  assert.equal(detectUsageLimit({ code: 0, stdout: 'Rate limit has been increased' }), false);
  assert.equal(detectUsageLimit({ code: 1, stderr: 'Permission denied' }), false);
});
test('an autonomous batch waits and schedules a bounded rate-limit retry without replaying completed steps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-auto-'));
  await mkdir(path.join(root, '.git'));
  let workerCalls = 0;
  const manager = await new StudioManager({
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'Autonomous scene', steps: [
      { title: 'Technical framing', role: 'codex', prompt: 'Review assets.' },
      { title: 'Art pass', role: 'claude', prompt: 'Create production lookdev.' },
    ] }),
    decider: { route: async step => ({ role: step.role, source: 'fixture' }) },
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    worker: async () => {
      workerCalls++;
      return workerCalls === 2
        ? { code: 1, stdout: '', stderr: 'usage limit reached; resets at midnight' }
        : { code: 0, stdout: 'done', stderr: '' };
    },
  }).init();
  let id;
  try {
    const task = await manager.create({ project: root, goal: 'Polish main menu', policy: auton });
    id = task.id;
    assert.equal(manager.get(id).policy.tripoCreditCap, 500);
    await manager.plan(id); await manager.approve(id); await manager.run(id);
    assert.equal(manager.get(id).status, 'waiting_for_limit_reset');
    assert.equal(manager.get(id).steps[0].state, 'completed');
    assert.equal(manager.get(id).steps[1].state, 'waiting_limit');
    assert.equal(manager.get(id).steps[1].rateLimitRetries, 1);
    assert.ok(Number.isFinite(Date.parse(manager.get(id).retryAt)));
    await manager.recover(id); // explicit owner can resolve earlier after inspection
    assert.equal(manager.get(id).status, 'approved');
    await manager.run(id);
    assert.equal(manager.get(id).status, 'awaiting_review');
    assert.equal(manager.get(id).steps[0].state, 'completed');
    assert.equal(workerCalls, 3);
  } finally {
    if (id) manager.clearRetry(id);
    await rm(root, { recursive: true, force: true });
  }
});
