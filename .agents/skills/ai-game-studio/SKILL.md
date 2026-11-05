---
name: ai-game-studio
description: Coordinate Codex, Claude Code, pplx-decider-flash and game QA in Mr. Mak Workspace.
---

# AI Game Studio

Use Mr. Mak Workspace as the host. Read project GDD, ART_BIBLE, frozen golden targets and AGENTS.md.

## Roles
- Owner: Game Director; approves art direction, budgets, long tests, publishing and major changes.
- Codex: receives original task; Game Designer, Technical Director and Gameplay Engineer; writes plan and specialist prompts.
- Claude Code: Art Director, Principal UI/UX, Animator, environment/lookdev and visual review.
- pplx-decider-flash: typed decision router through Ollama System One; cannot generate text or override spending/permissions.
- QA: deterministic tests and real engine screenshots; decider plus Claude review visual evidence.

## Procedure
1. Codex creates 2–8 substantial tasks with exact prompts and testable acceptance criteria.
2. Owner approves the production batch once.
3. For each step, query local Ollama via POST /v1/systemone with a typed choice decision; never use /api/chat for decider.
4. Delegate narrowly to the specialist; send only necessary file paths, selected references and output requirements.
5. Keep each batch in an isolated Git worktree. No concurrent editing of the same .tscn/.blend or sharing a live editor between writers.
6. Capture real in-engine screenshots, logs and stable Git commit IDs for review.
7. Independent technical and visual acceptance precede owner acceptance. Never auto-merge or auto-publish.

## Golden visual lock
Gameplay, visuals and tactile game feel are equal pillars. Frozen golden targets define composition, UI modes, camera, lighting and character integration. Never redraw them to excuse weak output.
- Claude owns visual proposals and acceptance; Codex owns implementation safety.
- Reject floating architecture, filler geometry, stretched button sprites, unreadable type, contradictory HUD modes and unconvincing lighting.
- Show visible interior upgrades; main menu is a cinematic van hero shot, not a placeholder.
- Prefer authored silhouettes/materials/light hierarchy over repeated numeric tuning.
- Compare actual Godot screenshots with goldens; list five most important mismatches and corrective actions.

## Connected creative tools
Consult existing game-ui-workflow, gameplay-visual-review, blender-game-animation, materials-to-game and image-reference-workflow skills. External Playwright access to ChatGPT, Tripo, Mixamo, Fish Audio or music tools requires active legitimate access and individual permissions.
Tripo: default two generations per brief, maximum three only with owner budget approval. Track asset provenance, license, credit cost, source and target formats.
No CAPTCHA bypass, unauthorized purchases, new accounts, paid generations or external publishing.

## Permission and failure policy
Fast local validation can run automatically. GPU-intensive native tests and long QA need owner permission. If decider is offline, keep the Codex-authored role with a warning. Never allow a model to grant itself permissions. Never claim a CLI process exit proves game quality.
Current Studio Mode is an opt-in MVP; read docs/studio-mode.md for exact supported behavior and limitations.
