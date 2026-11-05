import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexBinary, commandPath, wrapCommand } from '../agents.mjs';

export async function runCommand(file, args, { cwd, input = '', timeoutMs = 30 * 60 * 1000, phase = 'Worker', spawnFn = spawn } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: stdout.slice(-24000), stderr: stderr.slice(-8000) });
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(phase + ' timed out after ' + Math.round(timeoutMs / 1000)
        + ' seconds. Check the worktree and the CLI process before retrying.');
      error.code = 'STUDIO_TIMEOUT';
      finish(error);
    }, timeoutMs);
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code));
    child.stdout?.on('data', data => { stdout = (stdout + data.toString()).slice(-24000); });
    child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export async function runCodexPlan({ project, goal, runner = runCommand }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-plan-'));
  const output = path.join(tmp, 'plan.json');
  const spec = [
    'You are the Technical Director and Game Designer. Produce a structured implementation plan only.',
    'Do not edit files, run paid tools or use web services. Return ONLY a valid JSON object with no fences:',
    '{"summary":"...","steps":[{"title":"...","role":"codex|claude|qa","prompt":"actionable instructions","acceptance":["testable outcome"],"needs_owner_review":false}]}',
    'Use 2-8 substantial steps, not microtasks. Claude owns art direction/UI/animation. Codex owns gameplay/technology. QA owns automated tests.',
    'Place independent tasks before dependent tasks. Reference existing files rather than inventing paths.',
    'Preserve established golden visual targets, game design, budget limits and functioning code.',
    'Goal:\n' + goal
  ].join('\n\n');
  try {
    const binary = codexBinary();
    const result = await runner(binary.file, [...binary.args, 'exec', '--sandbox', 'read-only', '-C', project, '--output-last-message', output, '-'], { cwd: project, input: spec, timeoutMs: 12 * 60 * 1000 });
    if (result.code !== 0) throw new Error('Codex planner failed: ' + result.stderr.slice(-700));
    return JSON.parse((await readFile(output, 'utf8')).trim());
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function runWorker({ role, cwd, prompt, runner = runCommand }) {
  if (role === 'qa') throw new Error('QA needs an explicitly approved test job, not an unattended AI worker.');
  const safety = '\n\nSTUDIO SAFETY: Work only inside this Git worktree. No paid Tripo, external purchases, sign-ins, browser-based AI generation or long-running game QA without owner approval. Never merge, force-push, publish, weaken approved golden targets, or modify other worktrees. Report blockers honestly.';
  if (role === 'codex') {
    const binary = codexBinary();
    return runner(binary.file, [...binary.args, 'exec', '--sandbox', 'workspace-write', '-C', cwd, '-'], { cwd, input: prompt + safety, timeoutMs: 45 * 60 * 1000 });
  }
  const claude = commandPath('claude');
  if (!claude) throw new Error('Claude Code CLI is not installed or not in PATH.');
  const command = wrapCommand(claude, ['-p', '--output-format', 'json', '--permission-mode', 'default']);
  return runner(command.file, command.args, { cwd, input: prompt + safety, timeoutMs: 45 * 60 * 1000 });
}
