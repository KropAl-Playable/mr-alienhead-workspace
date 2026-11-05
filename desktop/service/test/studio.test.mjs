import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalDecider, parseDecision, deterministicRoute } from '../studio/decider.mjs';
import { StudioManager, validatePlan } from '../studio/manager.mjs';

test('pplx-decider uses typed /v1/systemone instead of the chat API', async () => {
  let captured;
  const decider = new LocalDecider({ fetcher: async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ answers: { worker: { choice: 'claude', confidence: 0.97 } } }) };
  } });
  const result = await decider.route({ title: 'Lighting', prompt: 'Improve menu lighting', role: 'codex' });
  assert.equal(result.role, 'claude');
  assert.match(captured.url, /\/v1\/systemone$/);
  assert.equal(captured.body.model, 'pplx-decider-flash');
  assert.equal(captured.body.questions.worker.type, 'choice');
  assert.equal(parseDecision({ answers: { worker: { choice: 'codex' } } }), 'codex');
});
test('offline decision falls back to Codex-authored assignment, never an unauthorized origin', async () => {
  const decider = new LocalDecider({ fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await decider.route({ title: 'UI', prompt: 'Art direction', role: 'claude' })).role, 'claude');
  assert.equal(deterministicRoute('create ambient lighting and animation'), 'claude');
  assert.throws(() => new LocalDecider({ endpoint: 'https://remote.example' }), /loopback/);
});
test('plans must use bounded known roles', () => {
  assert.throws(() => validatePlan({ steps: [{ role: 'manager', title: 'x', prompt: 'y' }] }), /Invalid/);
  assert.throws(() => validatePlan({ steps: [] }), /1-8/);
});
test('studio requires owner approval and uses an isolated Git worktree without merging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-'));
  await mkdir(path.join(root, '.git'));
  let gitCalls = 0, workerCalls = 0;
  const opts = {
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'menu', steps: [{ title: 'Rebuild menu', role: 'claude', prompt: 'Create lowpoly lighting.', acceptance: ['golden screenshot'] }] }),
    decider: { route: async () => ({ role: 'claude', source: 'fixture' }) },
    command: async file => { assert.equal(file, 'git'); gitCalls++; return { code: 0, stdout: '', stderr: '' }; },
    worker: async ({ role }) => { assert.equal(role, 'claude'); workerCalls++; return { code: 0, stdout: 'Completed', stderr: '' }; }
  };
  const manager = await new StudioManager(opts).init();
  try {
    const task = await manager.create({ project: root, goal: 'Create premium main menu lighting.' });
    await assert.rejects(manager.run(task.id), /approval/);
    await manager.plan(task.id);
    assert.equal(manager.get(task.id).status, 'awaiting_approval');
    await manager.approve(task.id);
    await manager.run(task.id);
    assert.equal(gitCalls, 1); assert.equal(workerCalls, 1);
    assert.equal(manager.get(task.id).status, 'awaiting_review');
    const reload = await new StudioManager(opts).init();
    assert.equal(reload.get(task.id).status, 'awaiting_review');
    assert.equal(reload.list()[0].steps[0].prompt, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('QA step pauses until the owner confirms the external check', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-gate-'));
  await mkdir(path.join(root, '.git'));
  const manager = await new StudioManager({
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'check', steps: [{ title: 'Native QA', role: 'qa', prompt: 'Verify Godot screenshot against target.', acceptance: ['owner-reviewed capture'] }] }),
    decider: { route: async () => ({ role: 'qa', source: 'fixture' }) },
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    worker: async () => { throw new Error('QA must not run as a worker'); }
  }).init();
  try {
    const task = await manager.create({ project: root, goal: 'Validate native scene' });
    await manager.plan(task.id); await manager.approve(task.id); await manager.run(task.id);
    assert.equal(manager.get(task.id).status, 'awaiting_owner');
    await assert.rejects(manager.ownerReview(task.id, 'yes'), /explicit/);
    await manager.ownerReview(task.id, true);
    assert.equal(manager.get(task.id).status, 'approved');
    await manager.run(task.id);
    assert.equal(manager.get(task.id).status, 'awaiting_review');
  } finally { await rm(root, { recursive: true, force: true }); }
});
