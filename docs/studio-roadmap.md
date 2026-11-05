# AI Game Studio — implementation roadmap

Project: **Mr. Mak Workspace**, preserving its real CLI PTYs, mobile access, cards, MCP inventory and existing skills.

## Studio v0: integrated opt-in MVP (this PR)
- [x] Codex-first structured multi-step planning from the owner task.
- [x] pplx-decider-flash with local Ollama System One typed choice; Codex-plan fallback.
- [x] Claude Code as art/UX/animation specialist and Codex as tech/gameplay lead.
- [x] Owner plan approval, local task persistence, isolated Git worktrees, no auto merge.
- [x] Status panel in Chats and one-time owner review / interrupted-task recovery.
- [x] Shared Skill plus bounded offline unit tests.
- [ ] Real Windows CLI+Ollama+Godot live acceptance (requires owner's workstation).
- [ ] Automated CI evidence (GitHub Actions may need to be enabled for this repository).

## Studio v1: trustworthy handoff and execution
- Move from one sequential worktree to dependency-aware subtask worktrees with safe review/merge proposals.
- Surface live Codex and Claude events in the existing Chats UI, tied to native session IDs.
- Add bounded session resumption, safe cancellation, retries with paid-job receipt deduplication, and per-tool permission ledger.
- Preserve CLI subscriptions as default; introduce pluggable API executors without mixing their billing or credentials.
- Introduce a task DAG with file write sets, branch ownership, and editor/MCP leases (one Godot/Blender writer).

Acceptance: a Codex gameplay change and a Claude environment-art change can be reviewed separately and integrated without conflicted .tscn files or hidden spend.

## Studio v2: visual-direction agent
- Load immutable approved golden targets and project Visual Lock as files, never prompt-only memories.
- Allow Claude to propose art briefs, create imagegen concepts using authorized browser/MCP tools, author Blender materials and animations, and stage Godot UI layouts.
- Use existing image-reference-workflow, game-ui-workflow, gameplay-visual-review, materials-to-game, blender-game-animation.
- Evaluate optional third-party Blender Game Skills and Godot UI Integration in an isolated environment; pin commits, check license, inspect scripts and duplicate functionality before installing.
- Capture actual Godot service/dialogue/menu/card views at a fixed camera/resolution, compare composition and readability, record top 5 discrepancies.
- Store Art Director verdict, Technical Director verdict and owner acceptance separately. A model score cannot silently pass a missing golden screenshot.

Acceptance: close Road Trip's main-menu art gap with repeatable screenshot evidence and zero golden-target changes.

## Studio v3: QA scheduler and budget controls
- Dedicated immutable Git-SHA test worktree, bot input scenarios, smoke tests, crash reports, screenshot diffs and controlled Godot runtime captures.
- Short local static tests may auto-run. Long GPU/editor tests require owner approval and can be postponed while unrelated work continues.
- Enforce Tripo ledger (1500 starting credits, 2 attempts by default, 3rd explicit), audio/web-generation consent, asset provenance and licenses.
- For RTX 4070 12 GB, do not leave the 4B local model resident during heavy engine/Blender rendering if it causes VRAM contention.
- Make repeated/failed generations idempotent by external job ID; do not spend again after a timeout without checking receipts.
- For reviews, the decider returns only routing/boolean decisions; Claude performs the detailed visual analysis.

Acceptance: reproducible QA on stable commits; zero unauthorized paid jobs; resumable receipts.

## Studio v4: general-purpose multi-project production
- Multi-project Studio cards and dashboards inside Workspace.
- Godot/Unity adapters, shared role contracts and project-local policies.
- Project templates for art bible, GDD, asset manifest, test plans and approvals.
- API budget reports vs subscription usage; deterministic routing benchmark of 100+ game tasks; fail closed for unknown classifications.
- Exportable self-contained Skill pack for Codex and Claude Code.

Acceptance: attach a fresh Git-initialized game project and run an approved vertical-slice plan without copying Road Trip-specific assets or instructions.

## Review and operational policy

Keep the current CLI Chat workflow as the stable path. Do not switch default agents, remove skills, install browser extensions, spend credits, or enable permission bypass without consent. Major visual changes require a golden-target comparison before owner signoff. The experimental Studio panel is opt-in until v1/v2 complete.
