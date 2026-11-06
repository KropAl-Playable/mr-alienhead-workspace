# Studio Mode — first integrated release

Studio Mode extends existing Mr. Mak Chats and the local Node service. It is not another desktop app and does not replace the voice coordinator or normal subscription-backed Codex/Claude terminal tabs.

## Responsibilities

Codex receives the original goal and plans 1–8 substantial steps. Local Qwen3.5-4B routes each step through Ollama's schema-constrained chat API. Claude handles art, UI/UX and animation; Codex handles gameplay, Godot and integration. QA and owner reviews are independent gates. Game Studio owns none of the user's API keys.

## Prerequisites

- Node 22+, Git, signed-in Codex CLI, signed-in Claude Code CLI.
- Ollama installed: run `ollama pull qwen3.5:4b-q4_K_M` (3.3 GB GGUF, supports Windows/NVIDIA). For a smaller footprint, `qwen3.5:2b-q4_K_M` is another option, but the default code uses 4B.
- Ollama listening on 127.0.0.1:11434. Local routing calls `POST /api/chat` with `format` set to a strict JSON schema, `temperature: 0`, and a validated `codex|claude|qa` result.
- The previous `pplx-decider-flash` package requires MLX and does not work on this Windows/NVIDIA setup. Do NOT install `-mlx` variants.
- Git-initialized game project; Godot is recommended.
- First run `node scripts/check-studio-router.mjs`. A successful result reports `source: "qwen3.5:4b-q4_K_M"`; an unavailable model produces a clear fallback error and exit status 1. Run this smoke test only when you are ready to load the model on the GPU.
- If the model seems unsupported or returns malformed JSON, update Ollama. Some older Ollama builds had Qwen3.5 structured-output/think-mode issues. The router deliberately does not force `think: false` because of these compatibility reports.
- After each decision, Ollama is asked to unload the model (`keep_alive: "0s"`) to free VRAM for Godot and Blender.
- Real permissions and credits for any Playwright/Tripo/Mixamo/ChatGPT/Fish Audio integrations.

## Use in Chats

Open the Studio panel, enter an absolute game project folder and a major goal. Create the task and explicitly invoke Plan with Codex. Review the plan before Approve. Run batch invokes workers in an isolated Git worktree. No worker is authorized to purchase content or publish the game just because a task started.

The status is saved under ignored .mrmak/studio. A task ends awaiting_review after worker commands finish; game engine QA, visual acceptance and final merge are still separate. A QA or explicit creative decision stage pauses and requires owner involvement.

## Safety

Codex planning uses a read-only sandbox. Execution uses an isolated worktree and non-bypass CLI modes; Claude Code print mode keeps the standard permission gate. Headless permission requests may block: stop, inspect, and authorize in the actual provider before retrying. Do not enable global bypass permissions to make it succeed.

The Qwen router is constrained to loopback. A schema-valid response does not guarantee good judgment, and any model self-reported confidence would not be calibrated. If it is offline or returns malformed output, route according to Codex's planned role and record that fallback. A planned QA step is a hard gate and may not be downgraded by the local router. It never grants spending, access or merges.

Do not run intensive QA on the owner's active workstation without approval. Browser sessions, paid generation, screenshots through an occupied editor, and assets outside the worktree are subject to separate local permissions. Tripo budget and provenance must be recorded by the project's own manifest.

## Not yet implemented

This first release does NOT automatically merge feature branches, run long QA jobs on a timer, enforce third-party web credit limits at the browser layer, create live cross-agent context summaries, score visuals without real screenshots, or switch billing providers between CLI and API. These are explicit future improvements, not implied by the name.

## Skills

Source skills are in .agents/skills; Claude copies are in .claude/skills. Use npm run skills:sync after changing the source skill. Relevant preexisting modules: game-ui-workflow, gameplay-visual-review, materials-to-game, image-reference-workflow, blender-game-animation, feature-handoff.

An owner-review stop can be confirmed in Studio after manually completing the named QA or creative check; confirmation only records the owner's decision, not a passed automated test. Interrupted batches require manual worktree/receipt inspection before Recovery; the pending step may repeat actions.

## Why Studio may not appear after npm run build (Windows)

The desktop UI and Node service are packaged inside the **installed Tauri executable**. The repository's `Start Mr. Mak.cmd` prefers `%LOCALAPPDATA%\\Mr. Mak Workspace\\mrmak-workspace.exe` when present. Building the React UI with `npm run build` updates `dist/`, but it does **not** update an installed desktop runtime. A screenshot without Studio in the Chats header generally means the old executable is still running.

To install a current desktop build from the Studio branch:

1. Save ongoing CLI work. From the tray/menu, **quit** Mr. Mak completely; closing a window may only hide it. Do not force-kill live sessions.
2. Pull `feat/ai-multiagent-studio`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File .\\Setup.ps1 -Mode Desktop`. This requires Rust and Windows C++ build tools (see docs/getting-started.md).
3. Run the generated NSIS installer from `src-tauri/target/release/bundle/nsis/`. It updates the **installed runtime**, including both web UI and local service.
4. Launch via `Start Mr. Mak.cmd`. Look for **Studio** in the Chats header, to the left of the phone icon. Do not install an older GitHub Release over the development build.

Building a new installer does not automatically activate it. Avoid replacing or restarting a running user's application without consent.

## Qwen3.5 final JSON diagnostics

Qwen3.5 can spend an overly small output budget on internal reasoning and return `message.content: ""`. The router now uses budgets of 1024 then 3072 tokens, records only metadata (never internal thinking text), and falls back to the Codex-authored assignment after two invalid results. The request deliberately omits `think: false` because some Ollama versions fail to honor JSON-schema constraints in that mode.

Run `node scripts/check-studio-router.mjs`. If both attempts remain invalid, install the simpler non-thinking alternative:

```powershell
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

Add to the repository's ignored `.env`:

```text
MRMAK_STUDIO_ROUTER_MODEL=qwen3:4b-instruct-2507-q4_K_M
```

The installed Studio service reads this variable on startup; the standalone smoke-test script reads a **process environment variable**. To test the alternative from PowerShell without editing code, use:

```powershell
$env:MRMAK_STUDIO_ROUTER_MODEL = 'qwen3:4b-instruct-2507-q4_K_M'
node scripts/check-studio-router.mjs
```

If any problem persists, collect just the diagnostic metadata (`done_reason`, `contentChars`, `thinkingChars`, Ollama version); do not paste entire prompts or raw thinking.

## Blocked during worktree preparation (Windows / large Godot repositories)

If Studio shows `blocked`, **all steps still `pending`**, and the reason is `Worker timeout`, the old build likely timed out in its 30-second `git worktree add` phase. This happens **before Codex/Claude execute an assignment**; it is not proof that the agents failed the visual task.

The new build:
- Reports `phase: preparing_worktree` while making the isolated checkout.
- Allows 300 seconds for the initial Git checkout instead of 30 seconds.
- Shows `Git worktree checkout timed out after 300 seconds` if it still cannot finish.
- Offers **Retry worktree setup** only when the task is blocked, no worker has started, and the owner clicks the button.
- If a prior checkout is present, verifies its Git top-level and `studio/<task-id>` branch; it never deletes or overwrites unknown files.
- Reports a worker failure separately with the failed step rather than leaving a running step indefinitely.

**Recovery procedure:** update and reinstall the desktop app, quit the older version completely, open Studio, select the original blocked task, check for any active Git checkout process or partial checkout in `.mrmak/studio/worktrees/<task-id>`, and click **Retry worktree setup**. If Git reports an orphan branch or an incomplete checkout, stop and inspect it; do not force-remove the branch or folder automatically.

The first planned QA stage still requires manual owner confirmation in this MVP. Studio does not claim automated game testing for that stage.


## Studio UX: non-modal workspace, Live activity and Results

Studio is an **embedded dock** in the Chats window, not a blocking modal. In a wide window, the active CLI chat remains interactive to the left and Studio uses the right side. In narrow windows, Studio uses the content area but the header/tab controls remain accessible; clicking a chat tab returns to Chats. Click the Studio button again to toggle the dock.

Studio has three views:
- **Tasks**: production queue, plan progress, step-level state, run/recover permissions.
- **Live activity**: current owner/phase and a bounded timeline of *sanitized* Codex/Claude event summaries. The runner reads Codex \`exec --json\` and Claude \`-p --verbose --output-format stream-json\`. It does not render private reasoning, raw tool inputs or environment secrets. This is a lightweight activity feed, **not** an embedded PTY or a replay of complete terminal output.
- **Results**: Markdown and image files actually changed in the isolated Git worktree, plus final worker prose and per-step summaries. Files are previewed read-only, with path restrictions and size limits. Both uncommitted changes and files committed on the Studio branch are eligible. No user-visible "completed" label implies artistic acceptance.

### Restart / crash recovery

The queue is persisted in \`.mrmak/studio/tasks.json\`. On restart:
- \`planning\` becomes \`plan_interrupted\`; use **Plan with Codex** again.
- \`running\` becomes \`interrupted\`; click **Inspect & recover** only *after* inspecting partial files, connected service accounts and any paid-generation receipts.
- A blocked worker with failed steps can also be recovered explicitly. Only unfinished steps are queued for replay; completed steps are preserved.
- A historical \`approved\` task whose steps are all \`completed\` automatically becomes \`awaiting_review\` with a **View results** action. Do not click Run batch for a finished review package.
- A task waiting for an owner QA decision stays \`awaiting_owner\` after restart.

Recovery **does not restore the exact Codex/Claude in-memory conversation**. It safely replays the incomplete instruction in the existing worktree. Never assume a task replay cannot create duplicate paid jobs: this MVP still prohibits external paid generation without separate owner approval.

### How to review Objective #001

Open Studio → select Objective #001 → **Results**. Read the changed Markdown reports individually. The output from Codex/Claude appears in expandable step summaries, and the audit log appears in Live activity (recent tasks only). If older tasks have no saved event history, the new runner cannot reconstruct past activity; the existing generated files remain in the worktree shown in the task details.

If a report is not listed, copy the displayed worktree path and inspect the file directly. The artifact index is deliberately limited to changed \`.md\`, \`.txt\`, \`.json\` and image files, and will not scan/serve arbitrary repository files.
