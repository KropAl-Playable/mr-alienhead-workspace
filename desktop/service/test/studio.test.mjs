import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalDecider, parseDecision, deterministicRoute } from '../studio/decider.mjs';
import { StudioManager, validatePlan } from '../studio/manager.mjs';
import { StudioArtifacts } from '../studio/artifacts.mjs';
import { workerEvent, workerReport } from '../studio/runner.mjs';

test('Qwen GGUF router uses local Ollama chat with strict JSON schema', async () => {
  let captured;
  const decider = new LocalDecider({ fetcher: async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ message: { content: '{"role":"claude"}' } }) };
  } });
  const result = await decider.route({ title: 'Lighting', prompt: 'Improve menu lighting', role: 'codex' });
  assert.equal(result.role, 'claude');
  assert.equal(result.source, 'qwen3.5:4b-q4_K_M');
  assert.match(captured.url, /\/api\/chat$/);
  assert.equal(captured.body.model, 'qwen3.5:4b-q4_K_M');
  assert.equal(captured.body.format.type, 'object');
  assert.deepEqual(captured.body.format.properties.role.enum, ['codex', 'claude', 'qa']);
  assert.equal(captured.body.options.temperature, 0);
  assert.ok(captured.body.options.num_predict > 64);
  assert.equal(captured.body.stream, false);
  assert.equal(parseDecision({ message: { content: '{"role":"codex"}' } }), 'codex');
  assert.equal(parseDecision({ message: { content: '{"role":"sudo"}' } }), null);
  assert.equal(parseDecision({ message: { content: 'not-json' } }), null);
});
test('planned QA is a mandatory gate even if a model would reassign it', async () => {
  let called = false;
  const decider = new LocalDecider({ fetcher: async () => { called = true; throw Error('unexpected'); } });
  const result = await decider.route({ title: 'Native QA', prompt: 'Run screenshots', role: 'qa' });
  assert.equal(result.role, 'qa');
  assert.equal(result.source, 'codex-plan-qa-gate');
  assert.equal(called, false);
});
test('malformed Ollama response fails safe to Codex-authored role', async () => {
  const decider = new LocalDecider({ fetcher: async () => ({ ok: true, json: async () => ({ message: { content: '{"role":"root"}' } }) }) });
  const result = await decider.route({ title: 'Animation', prompt: 'Rig fox', role: 'claude' });
  assert.equal(result.role, 'claude');
  assert.equal(result.source, 'codex-plan-fallback');
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
    assert.equal(manager.get(task.id).status, 'awaiting_review');
    assert.equal(manager.get(task.id).status, 'awaiting_review');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reasoning-only response triggers one bounded retry and preserves diagnostics', async () => {
  const budgets = [];
  let calls = 0;
  const decider = new LocalDecider({ fetcher: async (url, init) => {
    calls++;
    budgets.push(JSON.parse(init.body).options.num_predict);
    return { ok: true, json: async () => calls === 1
      ? { done_reason: 'length', eval_count: 1024, message: { content: '', thinking: 'x'.repeat(20) } }
      : { done_reason: 'stop', message: { content: '{"role":"claude"}' } } };
  } });
  const result = await decider.route({ title: 'Environment art', prompt: 'Author a lowpoly scene', role: 'codex' });
  assert.equal(result.role, 'claude');
  assert.equal(result.source, 'qwen3.5:4b-q4_K_M');
  assert.deepEqual(budgets, [1024, 3072]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].finish, 'length');
  assert.equal(result.diagnostics[0].thinkingChars, 20);
});
test('two malformed finals use safe fallback without exposing thinking text', async () => {
  let calls = 0;
  const decider = new LocalDecider({ fetcher: async () => {
    calls++;
    return { ok: true, json: async () => ({ done_reason: 'length', message: { content: '', thinking: 'private-thought' } }) };
  } });
  const result = await decider.route({ title: 'Menu art', prompt: 'Create warm lighting', role: 'claude' });
  assert.equal(calls, 2);
  assert.equal(result.source, 'codex-plan-fallback');
  assert.equal(result.diagnostics.length, 2);
  assert.ok(!JSON.stringify(result).includes('private-thought'));
});
test('router supports explicit model override for nonthinking Qwen Instruct', async () => {
  const decider = new LocalDecider({ model: 'qwen3:4b-instruct-2507-q4_K_M',
    fetcher: async () => ({ ok: true, json: async () => ({ message: { content: '{"role":"codex"}' } }) }) });
  const result = await decider.route({ title: 'Mechanics', prompt: 'Implement card system', role: 'codex' });
  assert.equal(result.source, 'qwen3:4b-instruct-2507-q4_K_M');
});

test('worktree checkout timeout leaves all steps pending and permits guarded owner retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-timeout-'));
  await mkdir(path.join(root, '.git'));
  let calls = 0, executed = 0;
  const manager = await new StudioManager({
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'report', steps: [{ title: 'Technical summary', role: 'codex', prompt: 'Read code and report.', acceptance: ['report'] }] }),
    decider: { route: async () => ({ role: 'codex', source: 'fixture' }) },
    command: async (_file, _args, options) => {
      calls++;
      assert.equal(options.phase, 'Git worktree checkout');
      assert.equal(options.timeoutMs, 300000);
      if (calls === 1) throw Object.assign(new Error('Git worktree checkout timed out after 300 seconds.'), { code: 'STUDIO_TIMEOUT' });
      return { code: 0, stdout: '', stderr: '' };
    },
    worker: async () => { executed++; return { code: 0, stdout: 'Report saved.', stderr: '' }; }
  }).init();
  try {
    const task = await manager.create({ project: root, goal: 'Review golden targets' });
    await manager.plan(task.id); await manager.approve(task.id);
    await assert.rejects(manager.run(task.id), /Git worktree checkout timed out/);
    assert.equal(manager.get(task.id).status, 'blocked');
    assert.equal(manager.get(task.id).phase, 'worktree_setup_failed');
    assert.ok(manager.get(task.id).steps.every(step => step.state === 'pending'));
    assert.equal(executed, 0);
    await manager.retrySetup(task.id); await manager.run(task.id);
    assert.equal(manager.get(task.id).status, 'awaiting_review');
    assert.equal(calls, 2);
    assert.equal(executed, 1);
    await assert.rejects(manager.retrySetup(task.id), /Only blocked worktree setup/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker exception is reported as failed, not left permanently running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-worker-'));
  await mkdir(path.join(root, '.git'));
  const manager = await new StudioManager({
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'report', steps: [{ title: 'Technical summary', role: 'codex', prompt: 'Inspect code.', acceptance: ['report'] }] }),
    decider: { route: async () => ({ role: 'codex', source: 'fixture' }) },
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    worker: async () => { throw new Error('Codex CLI timed out'); }
  }).init();
  try {
    const task = await manager.create({ project: root, goal: 'Review golden targets' });
    await manager.plan(task.id); await manager.approve(task.id);
    await assert.rejects(manager.run(task.id), /Codex CLI timed out/);
    assert.equal(manager.get(task.id).status, 'blocked');
    assert.equal(manager.get(task.id).steps[0].state, 'failed');
    assert.equal(manager.get(task.id).phase, 'worker_failed');
    await assert.rejects(manager.retrySetup(task.id), /Only blocked worktree setup/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI events expose useful progress without exposing thinking or tool arguments', () => {
  assert.deepEqual(workerEvent('{"type":"thread.started"}', 'codex'), { kind: 'session', message: 'Codex session started' });
  assert.deepEqual(workerEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Menu audit ready' } }), 'codex'),
    { kind: 'message', message: 'Menu audit ready' });
  assert.equal(workerEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private chain' }] } }), 'claude'), null);
  assert.deepEqual(workerEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'private-file' } }] } }), 'claude'),
    { kind: 'tool', message: 'Claude is using Read' });
  assert.equal(workerEvent('not-json', 'codex'), null);
});
test('old approved finished batch migrates into result review, not another Run button', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-migrate-'));
  const stateDir = path.join(root, '.mrmak');
  await mkdir(path.join(stateDir, 'studio'), { recursive: true });
  try {
    await writeFile(path.join(stateDir, 'studio', 'tasks.json'), JSON.stringify([{
      id: 'finished-1', project: root, goal: 'Old objective', status: 'approved', approved: true,
      steps: [{ id: 1, title: 'Audit', role: 'claude', prompt: 'audit', state: 'completed' }],
      events: [], summary: 'Complete', createdAt: new Date().toISOString()
    }]));
    const manager = await new StudioManager({ repo: root, stateDir }).init();
    assert.equal(manager.get('finished-1').status, 'awaiting_review');
    await assert.rejects(manager.run('finished-1'), /approval/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('restarting a running Studio task marks it interrupted and owner may replay only unfinished step', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-resume-'));
  await mkdir(path.join(root, '.git'));
  const opts = {
    repo: root, stateDir: root,
    planner: async () => ({ summary: 'test', steps: [
      { title: 'Code', role: 'codex', prompt: 'Code first' },
      { title: 'Art', role: 'claude', prompt: 'Make art' }
    ] }),
    decider: { route: async step => ({ role: step.role, source: 'fixture' }) },
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    worker: async () => ({ code: 0, stdout: 'Done', stderr: '' })
  };
  try {
    const manager = await new StudioManager(opts).init();
    const created = await manager.create({ project: root, goal: 'Work safely' });
    await manager.plan(created.id); await manager.approve(created.id);
    const task = manager.get(created.id);
    task.status = 'running';
    task.steps[0].state = 'completed'; task.steps[1].state = 'running';
    await manager.persist();
    const restarted = await new StudioManager(opts).init();
    assert.equal(restarted.get(created.id).status, 'interrupted');
    await restarted.recover(created.id);
    assert.equal(restarted.get(created.id).status, 'approved');
    assert.equal(restarted.get(created.id).steps[0].state, 'completed');
    assert.equal(restarted.get(created.id).steps[1].state, 'pending');
    await restarted.run(created.id);
    assert.equal(restarted.get(created.id).status, 'awaiting_review');
    assert.equal(restarted.get(created.id).steps[0].state, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('changed artifact previews are bounded and traversal is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-artifacts-'));
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports', 'audit.md'), '# Visual audit\nReal results');
  const artifacts = new StudioArtifacts({ command: async () => ({
    code: 0, stdout: '?? reports/audit.md\0', stderr: ''
  }) });
  const task = { worktree: root };
  try {
    const files = await artifacts.list(task);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'reports/audit.md');
    const preview = await artifacts.preview(task, 'reports/audit.md');
    assert.match(preview.text, /Real results/);
    await assert.rejects(artifacts.preview(task, '../private.md'), /Invalid artifact path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker reports extract final prose instead of dumping raw JSONL tool arguments', () => {
  const codex = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'secret' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Audit was completed; review three Markdown reports.' } })
  ].join('\n');
  assert.match(workerReport(codex, 'codex'), /three Markdown reports/);
  assert.doesNotMatch(workerReport(codex, 'codex'), /secret/);
  const claude = JSON.stringify({ type: 'result', result: 'Visual direction requires warm key lighting.' });
  assert.match(workerReport(claude, 'claude'), /warm key lighting/);
});
