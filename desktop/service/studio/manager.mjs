import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { readJson, saveJson } from '../util.mjs';
import { runCommand, runCodexPlan, runWorker } from './runner.mjs';
import { LocalDecider } from './decider.mjs';

const roles = new Set(['codex', 'claude', 'qa']);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length < 16000;
export function validatePlan(value) {
  if (!value || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) throw new Error('Codex must return 1-8 planned steps.');
  return {
    summary: String(value.summary || '').slice(0, 2000),
    steps: value.steps.map((step, i) => {
      if (!validText(step.title) || !validText(step.prompt) || !roles.has(step.role)) throw new Error('Invalid plan step ' + (i + 1));
      return { id: i + 1, title: step.title.slice(0, 180), role: step.role, prompt: step.prompt.slice(0, 14000),
        acceptance: Array.isArray(step.acceptance) ? step.acceptance.filter(x => typeof x === 'string').slice(0, 12) : [],
        needsOwnerReview: !!step.needs_owner_review, state: 'pending' };
    })
  };
}
export class StudioManager {
  constructor({ repo, stateDir, planner = runCodexPlan, worker = runWorker, command = runCommand, decider = new LocalDecider() }) {
    this.repo = repo; this.dir = path.join(stateDir, 'studio'); this.file = path.join(this.dir, 'tasks.json');
    this.planner = planner; this.worker = worker; this.command = command; this.decider = decider;
    this.tasks = []; this.busy = new Set();
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
    this.tasks = await readJson(this.file, []);
    if (!Array.isArray(this.tasks)) this.tasks = [];
    for (const task of this.tasks) if (task.status === 'planning' || task.status === 'running') {
      task.status = 'interrupted'; task.note = 'Service restarted. Inspect worktree before resuming.';
    }
    await this.persist(); return this;
  }
  async persist() { await saveJson(this.file, this.tasks); }
  publicTask(task) { return { ...task, steps: task.steps.map(({ prompt, ...rest }) => rest) }; }
  list() { return this.tasks.slice().reverse().map(task => this.publicTask(task)); }
  get(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw Object.assign(new Error('Studio task not found'), { status: 404 });
    return task;
  }
  async create({ project, goal }) {
    if (!validText(goal)) throw new Error('A specific game-development goal is required.');
    if (typeof project !== 'string' || !path.isAbsolute(project)) throw new Error('Choose an absolute project folder.');
    const root = await realpath(project);
    if (!(await stat(path.join(root, '.git')).catch(() => null))) throw new Error('Studio projects must be Git repositories.');
    const task = { id: randomUUID(), project: root, goal: goal.trim(), status: 'draft', createdAt: new Date().toISOString(), steps: [], summary: '', approved: false };
    this.tasks.push(task); await this.persist(); return this.publicTask(task);
  }
  async plan(id) {
    const task = this.get(id);
    if (this.busy.has(id) || !['draft', 'plan_failed'].includes(task.status)) throw new Error('Task cannot be planned in its current state.');
    this.busy.add(id); task.status = 'planning'; await this.persist();
    try {
      const parsed = validatePlan(await this.planner({ project: task.project, goal: task.goal }));
      task.steps = parsed.steps; task.summary = parsed.summary; task.status = 'awaiting_approval'; task.approved = false;
      await this.persist(); return this.publicTask(task);
    } catch (error) {
      task.status = 'plan_failed'; task.note = String(error.message || error).slice(0, 700);
      await this.persist(); throw error;
    } finally { this.busy.delete(id); }
  }
  async approve(id) {
    const task = this.get(id);
    if (task.status !== 'awaiting_approval') throw new Error('Only a reviewed plan can be approved.');
    task.approved = true; task.status = 'approved'; await this.persist(); return this.publicTask(task);
  }
  async routing(id) {
    const task = this.get(id);
    const step = task.steps.find(s => s.state === 'pending');
    if (!step) return { status: 'complete' };
    const decision = await this.decider.route(step);
    return { stepId: step.id, title: step.title, plannedRole: step.role, ...decision };
  }
  async ownerReview(id, approved) {
    const task = this.get(id);
    if (task.status !== 'awaiting_owner' || typeof approved !== 'boolean') throw new Error('An outstanding owner review and explicit decision are required.');
    const step = task.steps.find(s => s.state === 'awaiting_owner');
    if (!step) throw new Error('No pending review step.');
    step.state = approved ? 'completed' : 'failed';
    task.status = approved ? 'approved' : 'blocked';
    task.note = approved ? 'Owner confirmed the required external review. Continue with Run batch.' : 'Owner rejected the step. Resolve before continuing.';
    await this.persist(); return this.publicTask(task);
  }
  async recover(id) {
    const task = this.get(id);
    if (task.status !== 'interrupted') throw new Error('Only interrupted batches can be recovered.');
    for (const step of task.steps) if (step.state === 'running') step.state = 'pending';
    task.status = 'approved';
    task.note = 'Recovery approved after manual inspection. A pending step may repeat work: check paid-generation receipts before continuing.';
    await this.persist(); return this.publicTask(task);
  }
  async run(id) {
    const task = this.get(id);
    if (!task.approved || !['approved', 'interrupted'].includes(task.status) || this.busy.has(id)) throw new Error('Owner approval required before execution.');
    this.busy.add(id); task.status = 'running'; await this.persist();
    try {
      const worktree = path.join(this.dir, 'worktrees', task.id);
      if (!task.worktree) {
        await mkdir(path.dirname(worktree), { recursive: true });
        const added = await this.command('git', ['-C', task.project, 'worktree', 'add', '-b', 'studio/' + task.id, worktree, 'HEAD'], { cwd: task.project, timeoutMs: 30000 });
        if (added.code !== 0) throw new Error('Could not create isolated worktree: ' + added.stderr.slice(-500));
        task.worktree = worktree; await this.persist();
      }
      for (const step of task.steps) {
        if (step.state === 'completed') continue;
        const decision = await this.decider.route(step);
        step.decision = decision; step.state = 'running'; await this.persist();
        const role = decision.role;
        if (role === 'qa' || step.needsOwnerReview) {
          step.state = 'awaiting_owner'; task.status = 'awaiting_owner';
          task.note = 'Review / QA permission required at step ' + step.id;
          await this.persist(); return this.publicTask(task);
        }
        const brief = ['Studio step ' + step.id + ': ' + step.title, 'Project goal: ' + task.goal,
          'Your specialty: ' + role, step.prompt, 'Acceptance: ' + step.acceptance.join('; '),
          'Other agents may have edited this branch. Preserve accepted changes.'].join('\n\n');
        const result = await this.worker({ role, cwd: task.worktree, prompt: brief });
        step.exitCode = result.code; step.report = (result.stdout || result.stderr || '').slice(-5000);
        if (result.code !== 0) {
          step.state = 'failed'; task.status = 'blocked'; await this.persist(); return this.publicTask(task);
        }
        step.state = 'completed'; await this.persist();
      }
      task.status = 'awaiting_review';
      task.note = 'No merge performed. Technical and visual QA, real Godot screenshots and final owner acceptance are required.';
      await this.persist(); return this.publicTask(task);
    } catch (error) {
      task.status = 'blocked'; task.note = String(error.message || error).slice(0, 700);
      await this.persist(); throw error;
    } finally { this.busy.delete(id); }
  }
}
