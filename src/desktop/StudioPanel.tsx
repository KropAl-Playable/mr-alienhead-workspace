import { useEffect, useState } from 'react'
import { api } from './client'
import './studio.css'

type StudioStep = { id: number; title: string; role: string; state: string; decision?: { role: string; source: string }; acceptance: string[] }
type StudioTask = { id: string; project: string; goal: string; status: string; summary: string; approved: boolean; note?: string; worktree?: string; steps: StudioStep[] }
export default function StudioPanel({ close, projectFolder }: { close: () => void; projectFolder: string }) {
  const [project, setProject] = useState(projectFolder)
  const [goal, setGoal] = useState('')
  const [tasks, setTasks] = useState<StudioTask[]>([])
  const [selected, setSelected] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    try { const result = await api<{ tasks: StudioTask[] }>('/studio/tasks'); setTasks(result.tasks) }
    catch (e) { setError(String(e instanceof Error ? e.message : e)) }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh() }, 2500); return () => clearInterval(timer) }, [])
  const current = tasks.find(t => t.id === selected) || tasks[0]
  const create = async () => {
    setWorking(true); setError('')
    try { const task = await api<StudioTask>('/studio/tasks', { project, goal }); setSelected(task.id); setGoal(''); await refresh() }
    catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    finally { setWorking(false) }
  }
  const action = async (name: string) => {
    if (!current) return
    if (name === 'recover' && !window.confirm('Have you inspected the interrupted worktree and any paid-generation receipts? A failed step may be retried.')) return
    if (name === 'owner-review' && !window.confirm('Confirm that you personally completed the required QA or creative review. This is not an automated QA pass.')) return
    if (name === 'run' && !window.confirm('Run this approved batch using your Codex and Claude CLI subscriptions? It may consume plan limits. No external paid generations are authorized.')) return
    setWorking(true); setError('')
    try { await api('/studio/tasks/' + current.id + '/' + name, name === 'owner-review' ? { approved: true } : {}); await refresh() }
    catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    finally { setWorking(false) }
  }
  return <div className="desk-scrim" onClick={close}><section className="studio-dialog" onClick={e => e.stopPropagation()} aria-label="AI Game Studio">
    <header><div><small>MR. MAK • MULTI-AGENT</small><h2>AI Game Studio</h2><p>Codex plans · local Qwen routes · Claude directs art · owner approves</p></div><button className="desk-icon" onClick={close} aria-label="Close Studio">×</button></header>
    <div className="studio-body"><section className="studio-new">
      <label>Game repository (absolute path)<input value={project} spellCheck={false} onChange={e => setProject(e.target.value)} /></label>
      <label>Production objective<textarea rows={3} placeholder="e.g. Bring Road Trip main menu to the approved golden target…" value={goal} onChange={e => setGoal(e.target.value)} /></label>
      <button className="desk-primary" disabled={working || !goal.trim() || !project.trim()} onClick={() => void create()}>Create Studio task</button>
      <p>All work uses an isolated Git worktree. No auto-merge, public release or paid asset generation.</p>
    </section>
    <section className="studio-queue"><h3>Production queue</h3>
      <div className="studio-task-list">{tasks.map(t => <button key={t.id} className={current?.id === t.id ? 'chosen' : ''} onClick={() => setSelected(t.id)}><strong>{t.goal.slice(0, 84)}</strong><small>{t.status} · {t.project.split(/[\\/]/).pop()}</small></button>)}</div>
    </section>
    {current && <section className="studio-detail"><h3>{current.status.replaceAll('_', ' ')}</h3><p>{current.summary || current.goal}</p>
      {current.steps.map(step => <div className="studio-step" key={step.id}><strong>{step.id}. {step.title}</strong><span>{step.decision?.role || step.role} · {step.state}</span>{step.acceptance?.length > 0 && <small>{step.acceptance.join(' · ')}</small>}</div>)}
      {current.note && <p className="studio-warning">{current.note}</p>}
      {current.worktree && <small>Worktree: {current.worktree}</small>}
      <div className="studio-actions">
        {['draft', 'plan_failed'].includes(current.status) && <button disabled={working} onClick={() => void action('plan')}>Plan with Codex</button>}
        {current.status === 'awaiting_approval' && <button disabled={working} onClick={() => void action('approve')}>Approve plan</button>}
        {current.status === 'approved' && <button disabled={working} onClick={() => void action('run')}>Run batch</button>}
        {current.status === 'awaiting_owner' && <button disabled={working} onClick={() => void action('owner-review')}>I completed the review · Continue</button>}
        {current.status === 'interrupted' && <button disabled={working} onClick={() => void action('recover')}>Recover after inspection</button>}
      </div>
    </section>}
    {error && <p className="desk-error-inline" role="alert">{error}</p>}
    </div>
  </section></div>
}
