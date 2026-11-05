# Studio Mode — first integrated release

Studio Mode extends existing Mr. Mak Chats and the local Node service. It is not another desktop app and does not replace the voice coordinator or normal subscription-backed Codex/Claude terminal tabs.

## Responsibilities

Codex receives the original goal and plans 1–8 substantial steps. pplx-decider-flash routes each step through local Ollama System One. Claude handles art, UI/UX and animation; Codex handles gameplay, Godot and integration. QA and owner reviews are independent gates. Game Studio owns none of the user's API keys.

## Prerequisites

- Node 22+, Git, signed-in Codex CLI, signed-in Claude Code CLI.
- Ollama installed: run ollama pull pplx-decider-flash.
- Ollama listening on 127.0.0.1:11434. This model is a decision model with POST /v1/systemone, not a conversational model.
- Git-initialized game project; Godot is recommended.
- Real permissions and credits for any Playwright/Tripo/Mixamo/ChatGPT/Fish Audio integrations.

## Use in Chats

Open the Studio panel, enter an absolute game project folder and a major goal. Create the task and explicitly invoke Plan with Codex. Review the plan before Approve. Run batch invokes workers in an isolated Git worktree. No worker is authorized to purchase content or publish the game just because a task started.

The status is saved under ignored .mrmak/studio. A task ends awaiting_review after worker commands finish; game engine QA, visual acceptance and final merge are still separate. A QA or explicit creative decision stage pauses and requires owner involvement.

## Safety

Codex planning uses a read-only sandbox. Execution uses an isolated worktree and non-bypass CLI modes; Claude Code print mode keeps the standard permission gate. Headless permission requests may block: stop, inspect, and authorize in the actual provider before retrying. Do not enable global bypass permissions to make it succeed.

The model router is constrained to loopback. If it is offline or returns malformed output, route according to Codex's planned role and record that fallback. It never grants spending, access or merges.

Do not run intensive QA on the owner's active workstation without approval. Browser sessions, paid generation, screenshots through an occupied editor, and assets outside the worktree are subject to separate local permissions. Tripo budget and provenance must be recorded by the project's own manifest.

## Not yet implemented

This first release does NOT automatically merge feature branches, run long QA jobs on a timer, enforce third-party web credit limits at the browser layer, create live cross-agent context summaries, score visuals without real screenshots, or switch billing providers between CLI and API. These are explicit future improvements, not implied by the name.

## Skills

Source skills are in .agents/skills; Claude copies are in .claude/skills. Use npm run skills:sync after changing the source skill. Relevant preexisting modules: game-ui-workflow, gameplay-visual-review, materials-to-game, image-reference-workflow, blender-game-animation, feature-handoff.

An owner-review stop can be confirmed in Studio after manually completing the named QA or creative check; confirmation only records the owner's decision, not a passed automated test. Interrupted batches require manual worktree/receipt inspection before Recovery; the pending step may repeat actions.
