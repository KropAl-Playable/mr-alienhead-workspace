import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { realFile } from '../util.mjs';
import { runCommand } from './runner.mjs';

// Read-only, allowlisted, bounded previews. Studio never serves arbitrary paths.
const allowed = /\.(?:md|txt|json|png|jpe?g|webp|svg)$/i;
const image = /\.(?:png|jpe?g|webp|svg)$/i;
function statusPaths(output) {
  const fields = String(output || '').split('\0');
  const names = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (!entry || entry.length < 4) continue;
    const flag = entry.slice(0, 2), name = entry.slice(3);
    names.push(name);
    if (/R|C/.test(flag)) index++; // -z rename/copy records include the original path.
  }
  return names;
}
function safeName(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').includes('..')
    || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('.git/')) return null;
  return allowed.test(normalized) ? normalized : null;
}
export class StudioArtifacts {
  constructor({ command = runCommand } = {}) { this.command = command; }
  async list(task) {
    if (!task?.worktree) return [];
    const root = task.worktree;
    const status = await this.command('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root, timeoutMs: 30000, phase: 'Studio artifact index' });
    if (status.code !== 0) throw new Error('Could not inspect changed files: ' + status.stderr.slice(0, 200));
    const candidates = statusPaths(status.stdout);
    let base = task.baseSha && /^[0-9a-f]{40}$/i.test(task.baseSha) ? task.baseSha : null;
    if (!base && task.project) {
      // Legacy Studio worktrees did not record an initial SHA. Use the common
      // ancestor with the current project branch so committed reports can be found.
      const parent = await this.command('git', ['-C', task.project, 'rev-parse', 'HEAD'],
        { cwd: root, timeoutMs: 15000, phase: 'Studio artifact base' }).catch(() => null);
      if (parent?.code === 0 && /^[0-9a-f]{40}$/i.test(parent.stdout.trim())) {
        const common = await this.command('git', ['-C', root, 'merge-base', 'HEAD', parent.stdout.trim()],
          { cwd: root, timeoutMs: 15000, phase: 'Studio artifact ancestor' }).catch(() => null);
        if (common?.code === 0 && /^[0-9a-f]{40}$/i.test(common.stdout.trim())) base = common.stdout.trim();
      }
    }
    if (base) {
      const committed = await this.command('git', ['-C', root, 'diff', '--name-only', '-z', base, 'HEAD'],
        { cwd: root, timeoutMs: 30000, phase: 'Studio committed artifact index' });
      if (committed.code === 0) candidates.push(...committed.stdout.split('\0'));
    }
    const result = [];
    for (const candidate of [...new Set(candidates.map(safeName).filter(Boolean))].slice(0, 250)) {
      try {
        const file = await realFile(root, candidate);
        if (!file.info.isFile()) continue;
        result.push({ path: candidate, size: file.info.size, kind: image.test(candidate) ? 'image' : 'text' });
      } catch { /* Removed/renamed files are not artifacts. */ }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  async preview(task, relative) {
    const name = safeName(relative);
    if (!name || !task?.worktree) throw Object.assign(new Error('Invalid artifact path'), { status: 400 });
    const files = await this.list(task);
    const descriptor = files.find(f => f.path === name);
    if (!descriptor) throw Object.assign(new Error('Artifact is not among this task’s changed files'), { status: 404 });
    const file = await realFile(task.worktree, name);
    if (file.info.size > (descriptor.kind === 'image' ? 4 * 1024 * 1024 : 512 * 1024))
      throw Object.assign(new Error('Artifact is too large to preview here; inspect it in the worktree'), { status: 413 });
    const bytes = await readFile(file.file);
    if (descriptor.kind === 'text') return { ...descriptor, text: bytes.toString('utf8') };
    const ext = path.extname(name).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' :
      ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
    // Images are inline preview data; cannot be used to read unrelated local files.
    return { ...descriptor, data: 'data:' + mime + ';base64,' + bytes.toString('base64') };
  }
}
