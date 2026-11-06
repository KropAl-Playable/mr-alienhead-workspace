import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexBinary, commandPath, wrapCommand } from '../agents.mjs';

// Do not expose thinking, tool arguments, shell output, secrets, or entire prompts
// in Studio's activity panel. Only stable, short presentation events are stored.
const clipped = value => String(value || '').replace(/(?:sk-|ghp_|github_pat_|Bearer\s+)[A-Za-z0-9_.-]{12,}/gi, '[redacted]').slice(0, 360);
export function workerEvent(line, role) {
  let item;
  try { item = JSON.parse(line); } catch { return null; }
  if (!item || typeof item !== 'object') return null;
  if (role === 'codex') {
    if (item.type === 'thread.started') return { kind: 'session', message: 'Codex session started' };
    if (item.type === 'turn.started') return { kind: 'progress', message: 'Codex is working' };
    if (item.type === 'turn.completed') return { kind: 'progress', message: 'Codex turn completed' };
    if (item.type === 'turn.failed') return { kind: 'error', message: 'Codex turn failed' };
    if (item.type === 'item.started' && item.item?.type === 'command_execution') return { kind: 'tool', message: 'Codex is running a local command' };
    if (item.type === 'item.completed' && item.item?.type === 'agent_message')
      return { kind: 'message', message: clipped(item.item.text) };
    if (item.type === 'item.completed' && item.item?.type === 'file_change')
      return { kind: 'file', message: 'Codex updated project files' };
  }
  if (role === 'claude') {
    if (item.type === 'system' && item.subtype === 'init') return { kind: 'session', message: 'Claude session started' };
    if (item.type === 'assistant') {
      const blocks = item.message?.content;
      if (Array.isArray(blocks)) {
        const tool = blocks.find(v => v.type === 'tool_use');
        if (tool) return { kind: 'tool', message: 'Claude is using ' + clipped(tool.name) };
        const message = blocks.filter(v => v.type === 'text').map(v => v.text).join(' ').trim();
        if (message) return { kind: 'message', message: clipped(message) };
      }
    }
    if (item.type === 'result') return { kind: 'progress', message: item.is_error ? 'Claude reported an error' : 'Claude completed its turn' };
  }
  return null;
}
// Reduce JSONL from the CLI into a reviewable final answer. Never display tool
// argument payloads or internal reasoning as a "report".
export function workerReport(stdout, role) {
  let latest = '';
  for (const line of String(stdout || '').split('\n')) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (role === 'codex' && item.type === 'item.completed' && item.item?.type === 'agent_message') {
      latest = String(item.item.text || '');
    }
    if (role === 'claude') {
      if (item.type === 'result' && typeof item.result === 'string') latest = item.result;
      else if (item.type === 'assistant' && Array.isArray(item.message?.content)) {
        const parts = item.message.content.filter(v => v.type === 'text').map(v => v.text);
        if (parts.length) latest = parts.join('\n');
      }
    }
  }
  return latest.slice(-8000);
}
export async function runCommand(file, args, {
  cwd, input = '', timeoutMs = 30 * 60 * 1000, phase = 'Worker',
  spawnFn = spawn, onEvent, eventRole,
} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', lineBuffer = '', done = false;
    const emit = line => {
      if (!onEvent || !eventRole) return;
      const detail = workerEvent(line, eventRole);
      if (detail) try { onEvent(detail); } catch { /* Never crash the worker for UI progress. */ }
    };
    const finish = (error, code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (lineBuffer) emit(lineBuffer);
      if (error) reject(error);
      else resolve({ code, stdout: stdout.slice(-24000), stderr: stderr.slice(-8000) });
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(phase + ' timed out after ' + Math.round(timeoutMs / 1000)
        + ' seconds. Check the worktree and CLI process before retrying.');
      error.code = 'STUDIO_TIMEOUT';
      finish(error);
    }, timeoutMs);
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code));
    child.stdout?.on('data', data => {
      const chunk = data.toString();
      stdout = (stdout + chunk).slice(-24000);
      lineBuffer += chunk;
      if (lineBuffer.length > 256 * 1024) lineBuffer = lineBuffer.slice(-64 * 1024);
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) >= 0) {
        emit(lineBuffer.slice(0, nl));
        lineBuffer = lineBuffer.slice(nl + 1);
      }
    });
    child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export async function runCodexPlan({ project, goal, runner = runCommand, onEvent }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mrmak-studio-plan-'));
  const output = path.join(tmp, 'plan.json');
  const spec = [
    'You are the Technical Director and Game Designer. Produce a structured implementation plan only.',
    'Do not edit files, run paid tools or use web services. Return ONLY a valid JSON object with no fences:',
    '{"summary":"...","steps":[{"title":"...","role":"codex|claude|qa","prompt":"actionable instructions","acceptance":["testable outcome"],"needs_owner_review":false}]}',
    'Use 2-8 substantial steps, not microtasks. Claude owns art direction/UI/animation. Codex owns gameplay/technology. QA owns automated tests.',
    'Place independent tasks before dependent tasks. Reference existing files rather than inventing paths.',
    'Preserve established golden visual targets, game design, budget limits and functioning code.',
    'Goal:\n' + goal,
  ].join('\n\n');
  try {
    const binary = codexBinary();
    const result = await runner(binary.file, [...binary.args, 'exec', '--sandbox', 'read-only', '-C', project, '--json', '--output-last-message', output, '-'],
      { cwd: project, input: spec, timeoutMs: 12 * 60 * 1000, phase: 'Codex planning', onEvent, eventRole: 'codex' });
    if (result.code !== 0) throw new Error('Codex planner failed: ' + result.stderr.slice(-700));
    return JSON.parse((await readFile(output, 'utf8')).trim());
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function runWorker({ role, cwd, prompt, runner = runCommand, onEvent }) {
  if (role === 'qa') throw new Error('QA needs an explicitly approved test job, not an unattended AI worker.');
  const safety = '\n\nSTUDIO SAFETY: Work only inside this Git worktree. No paid Tripo, external purchases, sign-ins, browser-based AI generation or long-running game QA without owner approval. Never merge, force-push, publish, weaken approved golden targets, or modify other worktrees. Report blockers honestly.';
  if (role === 'codex') {
    const binary = codexBinary();
    return runner(binary.file, [...binary.args, 'exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, '-'],
      { cwd, input: prompt + safety, timeoutMs: 45 * 60 * 1000, phase: 'Codex worker', onEvent, eventRole: 'codex' });
  }
  const claude = commandPath('claude');
  if (!claude) throw new Error('Claude Code CLI is not installed or not in PATH.');
  const command = wrapCommand(claude, ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'default']);
  return runner(command.file, command.args, { cwd, input: prompt + safety,
    timeoutMs: 45 * 60 * 1000, phase: 'Claude worker', onEvent, eventRole: 'claude' });
}
