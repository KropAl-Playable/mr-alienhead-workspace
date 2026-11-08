import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { readJson, saveJson } from '../util.mjs';
import { runCommand, runCodexPlan, runWorker, workerReport, detectUsageLimit } from './runner.mjs';
import { guardedPolicy, validateStudioPolicy, isAutonomous, policyBrief } from './policy.mjs';
import { LocalDecider } from './decider.mjs';
import { StudioArtifacts } from './artifacts.mjs';

const roles = new Set(['codex', 'claude', 'qa']);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length < 16000;

export function validatePlan(value) {
  if (!value || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8)
    throw new Error('Codex must return 1-8 planned steps.');
  return {
    summary: String(value.summary || '').slice(0, 2000),
    steps: value.steps.map((step, i) => {
      if (!validText(step.title) || !validText(step.prompt) || !roles.has(step.role))
        throw new Error('Invalid plan step ' + (i + 1));
      return {
        id: i + 1, title: step.title.slice(0, 180), role: step.role,
        prompt: step.prompt.slice(0, 14000),
        acceptance: Array.isArray(step.acceptance) ? step.acceptance.filter(x => typeof x === 'string').slice(0, 12) : [],
        needsOwnerReview: !!step.needs_owner_review, state: 'pending',
      };
    }),
  };
}

export class StudioManager {
  constructor({
    repo, stateDir, planner = runCodexPlan, worker = runWorker,
    command = runCommand, decider = new LocalDecider(),
    artifacts = new StudioArtifacts({ command }),
  }) {
    this.repo = repo;
    this.dir = path.join(stateDir, 'studio');
    this.file = path.join(this.dir, 'tasks.json');
    this.planner = planner; this.worker = worker; this.command = command;
    this.decider = decider; this.artifacts = artifacts;
    this.tasks = []; this.busy = new Set(); this.eventTimers = new Map(); this.retryTimers = new Map();
    this.saving = Promise.resolve();
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
    this.tasks = await readJson(this.file, []);
    if (!Array.isArray(this.tasks)) this.tasks = [];
    for (const task of this.tasks) {
      task.events ||= [];
      task.policy ||= guardedPolicy();
      if (task.status === 'waiting_for_limit_reset') this.scheduleRetry(task);
      if (task.status === 'planning') {
        task.status = 'plan_interrupted';
        task.note = 'Planning was interrupted by restart. You may safely re-run Codex planning.';
      } else if (task.status === 'running') {
        task.status = 'interrupted';
        task.note = 'Studio restarted during execution. Inspect partial files and receipts before replaying a step.';
        this.event(task, 'warning', 'Service restarted: execution needs owner recovery.');
      } else if (task.status === 'approved' && task.steps.length && task.steps.every(s => s.state === 'completed')) {
        // Historical tasks ended "approved" after the final manual QA confirmation.
        task.status = 'awaiting_review'; task.phase = null;
        task.note = 'All steps finished. Inspect actual reports and changed files; owner acceptance remains open.';
      }
    }
    await this.persist(); return this;
  }
  async persist() {
    this.saving = this.saving.catch(() => {}).then(() => saveJson(this.file, this.tasks));
    return this.saving;
  }
  event(task, kind, message, stepId = null) {
    task.events ||= [];
    task.events.push({
      at: new Date().toISOString(), kind, stepId,
      message: String(message || '').slice(0, 450),
    });
    if (task.events.length > 160) task.events = task.events.slice(-160);
    if (!this.eventTimers.has(task.id)) {
      this.eventTimers.set(task.id, setTimeout(() => {
        this.eventTimers.delete(task.id);
        void this.persist().catch(() => {});
      }, 600));
    }
  }
  async flushEvents(task) {
    const timer = this.eventTimers.get(task.id);
    if (timer) clearTimeout(timer);
    this.eventTimers.delete(task.id);
    await this.persist();
  }
  publicTask(task) {
    return { ...task, steps: task.steps.map(({ prompt, ...rest }) => rest) };
  }
  list() { return this.tasks.slice().reverse().map(task => this.publicTask(task)); }
  get(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw Object.assign(new Error('Studio task not found'), { status: 404 });
    return task;
  }
  async listArtifacts(id) { return this.artifacts.list(this.get(id)); }
  async previewArtifact(id, name) { return this.artifacts.preview(this.get(id), name); }

  async create({ project, goal, policy }) {
    if (!validText(goal)) throw new Error('A specific game-development goal is required.');
    if (typeof project !== 'string' || !path.isAbsolute(project)) throw new Error('Choose an absolute project folder.');
    const root = await realpath(project);
    if (!(await stat(path.join(root, '.git')).catch(() => null)))
      throw new Error('Studio projects must be Git repositories.');
    const task = {
      id: randomUUID(), project: root, goal: goal.trim(), status: 'draft',
      createdAt: new Date().toISOString(), steps: [], events: [],
      policy: validateStudioPolicy(policy),
      summary: '', approved: false,
    };
    this.tasks.push(task); await this.persist(); return this.publicTask(task);
  }
  async plan(id) {
    const task = this.get(id);
    if (this.busy.has(id) || !['draft', 'plan_failed', 'plan_interrupted'].includes(task.status))
      throw new Error('Task cannot be planned in its current state.');
    this.busy.add(id); task.status = 'planning';
    this.event(task, 'session', 'Codex is preparing the Studio plan.');
    await this.persist();
    try {
      const parsed = validatePlan(await this.planner({
        project: task.project, goal: task.goal, policy: task.policy,
        onEvent: info => this.event(task, info.kind, info.message),
      }));
      task.steps = parsed.steps; task.summary = parsed.summary;
      task.status = 'awaiting_approval'; task.approved = false;
      this.event(task, 'milestone', 'Codex plan is ready for approval.');
      await this.flushEvents(task); return this.publicTask(task);
    } catch (error) {
      task.status = 'plan_failed';
      task.note = String(error.message || error).slice(0, 700);
      this.event(task, 'error', task.note);
      await this.flushEvents(task); throw error;
    } finally { this.busy.delete(id); }
  }
  async approve(id) {
    const task = this.get(id);
    if (task.status !== 'awaiting_approval') throw new Error('Only a reviewed plan can be approved.');
    task.approved = true; task.status = 'approved';
    this.event(task, 'milestone', isAutonomous(task.policy) ? 'Owner approved AUTONOMOUS tools and Tripo credit envelope.' : 'Guarded mode enabled.');
    this.event(task, 'milestone', 'Owner approved production plan.');
    await this.flushEvents(task); return this.publicTask(task);
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
    if (this.busy.has(id) || task.status !== 'awaiting_owner' || typeof approved !== 'boolean')
      throw new Error('An outstanding owner review and explicit decision are required.');
    const step = task.steps.find(s => s.state === 'awaiting_owner');
    if (!step) throw new Error('No pending review step.');
    step.state = approved ? 'completed' : 'failed';
    step.finishedAt = new Date().toISOString();
    task.status = approved
      ? (task.steps.every(s => s.state === 'completed') ? 'awaiting_review' : 'approved')
      : 'blocked';
    task.phase = null;
    task.note = approved
      ? (task.status === 'awaiting_review' ? 'All steps finished; review deliverables.' : 'Owner confirmed the review. Continue with Run batch.')
      : 'Owner rejected the review; inspect issues before retrying.';
    this.event(task, approved ? 'milestone' : 'warning',
      approved ? 'Owner confirmed the external review step.' : 'Owner declined external review.', step.id);
    await this.flushEvents(task); return this.publicTask(task);
  }
  scheduleRetry(task) {
    this.clearRetry(task.id);
    if (task.status !== 'waiting_for_limit_reset' || !task.approved
      || !isAutonomous(task.policy) || task.policy.autoResume !== true || !task.retryAt) return;
    const due = Date.parse(task.retryAt);
    if (!Number.isFinite(due)) return;
    const delay = Math.max(1000, Math.min(2147483647, due - Date.now()));
    this.retryTimers.set(task.id, setTimeout(() => {
      this.retryTimers.delete(task.id);
      void this.resumeAfterLimit(task.id).catch(error => {
        this.event(task, 'error', 'Automatic limit recovery failed: ' + String(error.message || error));
        void this.flushEvents(task);
      });
    }, delay));
  }
  clearRetry(id) {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }
  async resumeAfterLimit(id) {
    const task = this.get(id);
    if (this.busy.has(id) || task.status !== 'waiting_for_limit_reset'
      || !isAutonomous(task.policy) || task.policy.autoResume !== true) return;
    if (!Number.isFinite(Date.parse(task.retryAt)) || Date.now() < Date.parse(task.retryAt)) {
      this.scheduleRetry(task); return;
    }
    const step = task.steps.find(s => s.state === 'waiting_limit');
    if (!step) throw new Error('No waiting step to recover.');
    step.state = 'pending'; task.retryAt = null; task.status = 'approved'; task.phase = 'resuming_after_limit';
    task.note = 'Limit-recovery retry started. Inspect external job receipts before any new paid submission.';
    this.event(task, 'milestone', 'Subscription limit cooldown finished; resuming the incomplete step.');
    await this.flushEvents(task);
    // The existing worktree is retained, and completed steps are not replayed.
    await this.run(id);
  }
  async recover(id) {
    const task = this.get(id);
    if (this.busy.has(id) || !task.approved || !['interrupted', 'blocked', 'waiting_for_limit_reset'].includes(task.status))
      throw new Error('Only interrupted or failed approved batches can be recovered.');
    this.clearRetry(id);
    const incomplete = task.steps.filter(s => s.state !== 'completed');
    if (!incomplete.length) {
      task.status = 'awaiting_review'; task.phase = null;
      task.note = 'All steps finished before interruption. Review existing results; nothing was rerun.';
      this.event(task, 'milestone', 'Recovered finished batch for review; nothing was rerun.');
    } else {
      // Replay is explicit, not restoration of a previous CLI session.
      for (const s of incomplete) if (['running', 'failed', 'waiting_limit'].includes(s.state)) s.state = 'pending';
      task.retryAt = null;
      task.status = 'approved'; task.phase = null;
      task.note = 'Recovered to approved. Inspect partial files and paid-generation receipts before Run batch. The interrupted step will be replayed.';
      this.event(task, 'warning', 'Owner requested safe replay. No CLI process launched by recovery.');
    }
    await this.flushEvents(task); return this.publicTask(task);
  }
  async retrySetup(id) {
    const task = this.get(id);
    if (this.busy.has(id) || task.status !== 'blocked' || !task.approved
      || task.worktree || task.steps.some(s => s.state !== 'pending'))
      throw new Error('Only blocked worktree setup with no started steps can be retried.');
    task.status = 'approved'; task.phase = null;
    task.note = 'Owner requested worktree setup retry. Existing checkout will be verified before continuation.';
    await this.persist(); return this.publicTask(task);
  }
  async run(id) {
    const task = this.get(id);
    if (!task.approved || task.status !== 'approved' || this.busy.has(id))
      throw new Error('Owner approval required before execution.');
    if (task.steps.length && task.steps.every(s => s.state === 'completed')) {
      task.status = 'awaiting_review'; task.phase = null;
      task.note = 'All steps finished; review reports and changed files.';
      await this.persist(); return this.publicTask(task);
    }
    this.busy.add(id); task.status = 'running'; task.phase = 'preparing_worktree';
    task.note = 'Preparing isolated Git worktree.';
    this.event(task, 'progress', task.note);
    await this.persist();
    try {
      const worktree = path.join(this.dir, 'worktrees', task.id);
      if (!task.worktree) {
        await mkdir(path.dirname(worktree), { recursive: true });
        const existing = await stat(worktree).catch(() => null);
        if (existing) {
          // Never overwrite/remove a checkout that survived a timeout.
          const root = await this.command('git', ['-C', worktree, 'rev-parse', '--show-toplevel'],
            { cwd: task.project, timeoutMs: 20000, phase: 'verify existing worktree' });
          const branch = await this.command('git', ['-C', worktree, 'branch', '--show-current'],
            { cwd: task.project, timeoutMs: 20000, phase: 'verify existing branch' });
          const actual = root.stdout?.trim().replaceAll('\\', '/').toLowerCase();
          if (root.code !== 0 || actual !== worktree.replaceAll('\\', '/').toLowerCase()
            || branch.code !== 0 || branch.stdout?.trim() !== 'studio/' + task.id)
            throw new Error('Unexpected worktree at ' + worktree + '. Inspect manually; Studio will not overwrite it.');
          task.worktree = worktree;
        } else {
          const added = await this.command('git',
            ['-C', task.project, 'worktree', 'add', '-b', 'studio/' + task.id, worktree, 'HEAD'],
            { cwd: task.project, timeoutMs: 300000, phase: 'Git worktree checkout' });
          if (added.code !== 0) throw new Error('Could not create isolated worktree: ' + added.stderr.slice(-500));
          task.worktree = worktree;
        }
        await this.persist();
      }
      task.phase = 'dispatching'; task.note = 'Worktree ready. Assigning next step.';
      this.event(task, 'milestone', 'Isolated worktree ready.');
      await this.persist();
      for (const step of task.steps) {
        if (step.state === 'completed') continue;
        if (step.state === 'awaiting_owner') {
          task.status = 'awaiting_owner';
          task.note = 'Outstanding owner review requires approval; no worker started.';
          await this.persist(); return this.publicTask(task);
        }
        if (step.state === 'failed') {
          task.status = 'blocked'; task.note = 'A failed step requires explicit recovery.';
          await this.persist(); return this.publicTask(task);
        }
        const decision = await this.decider.route(step);
        step.decision = decision; step.state = 'running';
        step.startedAt = new Date().toISOString(); task.phase = 'step_' + step.id;
        task.note = 'Running ' + decision.role + ': ' + step.title;
        this.event(task, 'session', task.note, step.id);
        await this.persist();
        const role = decision.role;
        if (role === 'qa' || step.needsOwnerReview) {
          step.state = 'awaiting_owner'; task.status = 'awaiting_owner';
          task.note = 'Review / QA authorization required for step ' + step.id;
          this.event(task, 'review', 'Owner review required; this is not an automated QA pass.', step.id);
          await this.flushEvents(task); return this.publicTask(task);
        }
        const brief = ['Studio step ' + step.id + ': ' + step.title,
          'Project goal: ' + task.goal, 'Your specialty: ' + role,
          step.prompt, 'Acceptance: ' + step.acceptance.join('; '),
          'Other agents may have edited this worktree. Preserve their accepted changes.',
          policyBrief(task.policy),
          'Codex: pass Claude concrete Playwright Extension MCP connection instructions/paths; Claude: validate MCP available before relying on it.'].join('\n\n');
        const result = await this.worker({
          role, cwd: task.worktree, prompt: brief,
          onEvent: info => this.event(task, info.kind, info.message, step.id),
          policy: task.policy,
        });
        step.exitCode = result.code;
        step.report = workerReport(result.stdout, role) || String(result.stderr || '').slice(-2000);
        step.finishedAt = new Date().toISOString();
        if (result.code !== 0 && isAutonomous(task.policy) && task.policy.autoResume
          && detectUsageLimit(result) && (step.rateLimitRetries || 0) < task.policy.maxRateLimitRetries) {
          step.rateLimitRetries = (step.rateLimitRetries || 0) + 1;
          step.state = 'waiting_limit'; task.status = 'waiting_for_limit_reset';
          task.phase = 'limit_cooldown';
          task.retryAt = new Date(Date.now() + task.policy.retryDelayMinutes * 60000).toISOString();
          task.note = 'CLI usage limit detected; automatic retry #' + step.rateLimitRetries
            + ' scheduled for ' + task.retryAt + '. This will replay only the unfinished step.';
          this.event(task, 'warning', task.note, step.id);
          this.scheduleRetry(task);
          await this.flushEvents(task); return this.publicTask(task);
        }
        if (result.code !== 0) {
          step.state = 'failed'; task.status = 'blocked';
          this.event(task, 'error', role + ' exited with code ' + result.code, step.id);
          await this.flushEvents(task); return this.publicTask(task);
        }
        step.state = 'completed';
        this.event(task, 'milestone', role + ' finished step (not yet independently reviewed).', step.id);
        await this.flushEvents(task);
      }
      task.status = 'awaiting_review'; task.phase = null;
      task.note = 'Batch finished. Review reports, changed files and native screenshots. No merge was performed.';
      this.event(task, 'review', 'Batch finished; owner acceptance is still required.');
      await this.flushEvents(task); return this.publicTask(task);
    } catch (error) {
      task.status = 'blocked';
      const step = task.steps.find(s => s.state === 'running');
      if (step) step.state = 'failed';
      task.note = String(error.message || error).slice(0, 700)
        + (step ? ' Inspect partial step output before replaying.' : ' No agent step started.');
      task.phase = step ? 'worker_failed' : 'worktree_setup_failed';
      this.event(task, 'error', task.note, step?.id);
      await this.flushEvents(task); throw error;
    } finally { this.busy.delete(id); }
  }
}
