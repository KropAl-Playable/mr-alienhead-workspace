import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './client'
import './studio.css'

type StudioEvent = { at: string; kind: string; stepId?: number | null; message: string }
type StudioStep = {
  id: number; title: string; role: string; state: string; report?: string;
  decision?: { role: string; source: string }; acceptance: string[];
  startedAt?: string; finishedAt?: string; exitCode?: number
}
type StudioTask = {
  id: string; project: string; goal: string; status: string; phase?: string | null;
  summary: string; approved: boolean; note?: string; worktree?: string;
  steps: StudioStep[]; events?: StudioEvent[]
}
type Artifact = { path: string; kind: 'text' | 'image'; size: number }
type Preview = Artifact & { text?: string; data?: string }
type Section = 'queue' | 'activity' | 'results'
const label = (value: string) => value.replace(/_/g, ' ')
const date = (value: string) => {
  try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return value }
}
export default function StudioPanel({ close, projectFolder }: { close: () => void; projectFolder: string }) {
  const [project, setProject] = useState(projectFolder)
  const [goal, setGoal] = useState('')
  const [tasks, setTasks] = useState<StudioTask[]>([])
  const [selected, setSelected] = useState('')
  const [view, setView] = useState<Section>('queue')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [artifactError, setArtifactError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const refresh = async () => {
    try {
      const result = await api<{ tasks: StudioTask[] }>('/studio/tasks')
      setTasks(result.tasks)
    } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
  }
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [])
  const current = tasks.find(t => t.id === selected) || tasks[0]
  const activeStep = current?.steps.find(s => s.state === 'running')
  const completed = current?.steps.filter(s => s.state === 'completed').length || 0
  useEffect(() => {
    if (view !== 'results' || !current?.id) return
    let valid = true
    setArtifactError('')
    api<{ files: Artifact[] }>('/studio/tasks/' + current.id + '/artifacts')
      .then(data => { if (valid) setArtifacts(data.files) })
      .catch(e => { if (valid) setArtifactError(String(e instanceof Error ? e.message : e)) })
    return () => { valid = false }
  }, [view, current?.id, current?.status])
  useEffect(() => {
    if (view === 'activity' && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [view, current?.events?.length])
  useEffect(() => { setPreview(null); setArtifacts([]) }, [current?.id])
  const create = async () => {
    setWorking(true); setError('')
    try {
      const task = await api<StudioTask>('/studio/tasks', { project, goal })
      setSelected(task.id); setGoal(''); setView('queue'); await refresh()
    } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    finally { setWorking(false) }
  }
  const action = async (name: string) => {
    if (!current) return
    if (name === 'recover' && !window.confirm(
      'You must inspect incomplete worktree files, active agent processes, and any paid-generation receipts. Recovery REPLAYS the interrupted step, not the exact CLI session. Continue?')) return
    if (name === 'retry-setup' && !window.confirm(
      'Check for an unfinished Git checkout and active Git processes first. Retry worktree setup?')) return
    if (name === 'owner-review' && !window.confirm(
      'Confirm that you PERSONALLY completed this QA/creative review. This button does not run tests.')) return
    if (name === 'run' && !window.confirm(
      'Run approved steps via Codex and Claude CLI subscriptions? This consumes plan limits. External paid generation remains prohibited.')) return
    setWorking(true); setError('')
    try {
      await api('/studio/tasks/' + current.id + '/' + name, name === 'owner-review' ? { approved: true } : {})
      if (name === 'run' || name === 'plan') setView('activity')
      await refresh()
    } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    finally { setWorking(false) }
  }
  const showArtifact = async (file: Artifact) => {
    if (!current) return
    setPreviewBusy(true); setArtifactError('')
    try {
      const item = await api<Preview>('/studio/tasks/' + current.id + '/preview?path=' + encodeURIComponent(file.path))
      setPreview(item)
    } catch (e) { setArtifactError(String(e instanceof Error ? e.message : e)) }
    finally { setPreviewBusy(false) }
  }
  const selectTask = (id: string) => {
    setSelected(id); setPreview(null); setView('queue')
  }
  return <aside className="studio-pane" aria-label="AI Game Studio">
    <header className="studio-pane-heading">
      <div><small>MR. MAK / MULTI-AGENT</small><h2>AI Game Studio</h2>
        <p>Codex plans · Qwen routes · Claude builds · you review</p></div>
      <button className="desk-icon" onClick={close} aria-label="Close Studio" title="Return to Chats">×</button>
    </header>
    <nav className="studio-nav" aria-label="Studio sections">
      {([['queue', 'Tasks'], ['activity', 'Live activity'], ['results', 'Results']] as const).map(([key, title]) =>
        <button key={key} type="button" className={view === key ? 'active' : ''} onClick={() => setView(key)}>
          {title}{key === 'activity' && current?.status === 'running' && <i aria-label="Running" />}
        </button>)}
    </nav>
    <div className="studio-pane-scroll">
      {view === 'queue' && <>
        <details className="studio-create"><summary>+ New objective</summary>
          <label>Game repository (absolute path)<input value={project} spellCheck={false} onChange={e => setProject(e.target.value)} /></label>
          <label>Production objective<textarea rows={3} value={goal} placeholder="Describe a production goal…" onChange={e => setGoal(e.target.value)} /></label>
          <button className="studio-action-primary" disabled={working || !project.trim() || !goal.trim()} onClick={() => void create()}>Create Studio task</button>
        </details>
        <h3>Production queue</h3>
        <div className="studio-task-list">{tasks.map(task =>
          <button key={task.id} className={current?.id === task.id ? 'chosen' : ''} onClick={() => selectTask(task.id)}>
            <strong>{task.goal.replace(/^#+\s*/g, '').slice(0, 98)}</strong>
            <small>{label(task.status)} · {task.steps.filter(s => s.state === 'completed').length}/{task.steps.length} · {task.project.split(/[\\/]/).pop()}</small>
          </button>)}
          {!tasks.length && <p className="studio-muted">No Studio tasks yet. Add an objective above.</p>}
        </div>
        {current && <section className="studio-task-detail">
          <div className="studio-task-heading"><h3>{label(current.status)}</h3><span>{completed}/{current.steps.length} steps</span></div>
          {current.phase && <div className="studio-running-indicator"><span className="studio-pulse" />{label(current.phase)}</div>}
          <p>{current.summary || current.goal}</p>
          {current.steps.map(step => <details className={'studio-step studio-state-' + step.state} key={step.id}>
            <summary><strong>{step.id}. {step.title}</strong><small>{step.decision?.role || step.role} · {step.state === 'completed' ? 'finished, unreviewed' : label(step.state)}</small></summary>
            {step.acceptance?.length > 0 && <p>Acceptance: {step.acceptance.join(' · ')}</p>}
            {step.startedAt && <p>Started {date(step.startedAt)}{step.finishedAt ? ' · Finished ' + date(step.finishedAt) : ''}</p>}
            {step.report && <details className="studio-transcript"><summary>Worker output excerpt</summary><pre>{step.report}</pre></details>}
          </details>)}
          {current.note && <p className="studio-note">{current.note}</p>}
          {current.worktree && <p className="studio-path">Worktree: <code>{current.worktree}</code></p>}
          <div className="studio-actions">
            {['draft', 'plan_failed', 'plan_interrupted'].includes(current.status) && <button disabled={working} onClick={() => void action('plan')}>Plan with Codex</button>}
            {current.status === 'awaiting_approval' && <button disabled={working} onClick={() => void action('approve')}>Approve plan</button>}
            {current.status === 'approved' && <button disabled={working} onClick={() => void action('run')}>Run batch</button>}
            {current.status === 'awaiting_owner' && <button disabled={working} onClick={() => void action('owner-review')}>I completed the review</button>}
            {['interrupted', 'blocked'].includes(current.status) &&
              (current.worktree || current.steps.some(s => ['running', 'failed', 'completed'].includes(s.state))) &&
              <button disabled={working} onClick={() => void action('recover')}>Inspect &amp; recover</button>}
            {current.status === 'blocked' && !current.worktree && current.steps.every(s => s.state === 'pending') &&
              <button disabled={working} onClick={() => void action('retry-setup')}>Retry worktree setup</button>}
            {(current.status === 'awaiting_review' || current.steps.some(s => s.state === 'completed')) &&
              <button onClick={() => setView('results')}>View results →</button>}
          </div>
        </section>}
      </>}
      {view === 'activity' && <>
        {current ? <>
          <section className="studio-live-summary" aria-live="polite">
            <div className="studio-task-heading"><h3>{label(current.status)}</h3><span>{completed}/{current.steps.length}</span></div>
            {activeStep ? <p><span className="studio-pulse" />{activeStep.decision?.role || activeStep.role}: {activeStep.title}</p> :
              <p>{current.phase ? 'Phase: ' + label(current.phase) : current.note || 'Waiting for next action.'}</p>}
          </section>
          <div className="studio-activity-feed" ref={feedRef} role="log" aria-label="Studio worker activity">
            {(current.events || []).map((entry, i) => <div className={'studio-event studio-event-' + entry.kind} key={entry.at + '-' + i}>
              <time>{date(entry.at)}</time><span>{entry.message}</span>
              {entry.stepId != null && <small>#{entry.stepId}</small>}
            </div>)}
            {!(current.events || []).length && <p className="studio-muted">Activity will appear here as agents start. Older tasks may have no saved event history.</p>}
          </div>
          {current.status === 'awaiting_review' && <button className="studio-action-primary" onClick={() => setView('results')}>Review deliverables →</button>}
        </> : <p className="studio-muted">Select a task in the queue first.</p>}
      </>}
      {view === 'results' && <>
        {current ? <>
          <div className="studio-task-heading"><h3>Review deliverables</h3><span>{label(current.status)}</span></div>
          <p className="studio-muted">Only files actually changed in this isolated Git worktree appear below. CLI completion is not artistic acceptance.</p>
          {current.worktree && <p className="studio-path"><code>{current.worktree}</code></p>}
          <div className="studio-artifact-list">
            {artifacts.map(file => <button className={preview?.path === file.path ? 'active' : ''} key={file.path}
              title={file.path} onClick={() => void showArtifact(file)}>
              <span>{file.kind === 'image' ? '▧' : '▤'}</span>{file.path}
              <small>{Math.ceil(file.size / 1024)} KB</small>
            </button>)}
          </div>
          {!artifacts.length && <p className="studio-muted">No changed Markdown/images found yet. Check the worktree above and individual worker outputs. If an agent committed its files, older batches may not have a base SHA for comparison.</p>}
          {previewBusy && <p className="studio-muted">Opening artifact…</p>}
          {preview?.kind === 'text' && <article className="studio-markdown" aria-label={'Artifact: ' + preview.path}>
            <h4>{preview.path}</h4>
            {preview.path.match(/\.md$/i) ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text || ''}</ReactMarkdown> : <pre>{preview.text}</pre>}
          </article>}
          {preview?.kind === 'image' && <figure className="studio-image-preview"><img src={preview.data} alt={preview.path} /><figcaption>{preview.path}</figcaption></figure>}
          <h4>Agent step summaries</h4>
          {current.steps.map(step => <details className="studio-step" key={step.id}>
            <summary><strong>{step.id}. {step.title}</strong><small>{step.decision?.role || step.role}</small></summary>
            <p>{label(step.state)} · exit code: {step.exitCode ?? 'not recorded'}</p>
            {step.report ? <pre className="studio-worker-report">{step.report}</pre> : <p>No worker transcript was captured for this step.</p>}
          </details>)}
        </> : <p className="studio-muted">Choose a task first.</p>}
      </>}
      {(error || artifactError) && <p className="desk-error-inline" role="alert">{error || artifactError}</p>}
    </div>
  </aside>
}
