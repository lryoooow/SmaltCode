# SmaltCode architecture

> Public preview v0.0.1. This document describes the implemented kernel and desktop architecture.

## 1. Process model

```text
CLI / REPL → ClientPort → Kernel (in-process)
Electron React → preload IPC → DesktopBridge → Kernel (main process)
External client → JSON-RPC stdio → smalt serve → Kernel
```

The kernel is assembled once (`Kernel` in `core/kernel.ts`) and exposes a
transport-agnostic `handle(method, params)`. The CLI links the kernel
in-process through a `ClientPort`; `smalt serve` bridges the same surface to
a stdio `Peer`. Both paths are identical from the kernel's point of view.

`ClientPort` is the whole host contract:

```ts
interface ClientPort {
  notify(method, params): void;                        // streaming updates
  requestApproval(req): Promise<ApprovalDecision>;      // reverse request
  askUser(req): Promise<string>;                        // reverse request
}
```

Approvals as *reverse requests* (rather than event pairs) give us timeout,
cancellation and correlation for free from the RPC layer.

## 2. Concept model

| concept | meaning |
|---|---|
| **Thread** | a persisted conversation (`~/.smalt/threads/<id>.jsonl`) |
| **Turn** | one unit of work: user input → agent works → agent stops. Single-flight per thread |
| **Item** | observable unit inside a turn (userMessage, agentMessage, reasoning, commandExecution, fileChange, plan, userInputRequest) with `started → delta* → completed` |

## 3. The turn loop (`core/turn-runner.ts`)

```
runTurn(input)
  ├─ persist user message (item + history + store)
  ├─ UserPromptSubmit hooks
  └─ loop (unlimited by default; optional explicit SMALT_MAX_STEPS):
       ├─ fold steer queue into history
       ├─ compaction check (estimate ⊕ reported usage vs context window)
       ├─ context pipeline → prompt messages
       ├─ model stream → reasoning/text deltas → items
       │    tool-call assembly (id, name, argument fragments)
       ├─ no tool calls → Stop hooks
       │    blocked → inject system-reminder, continue (once)
       │    else → break
       └─ for each tool call: ToolOrchestrator.execute → tool result
            → append to history → next iteration
  finally: persist usage, turn-ended, AGENT_ENDED, drain queued input
```

Interruption is a first-class outcome: aborted streams/tools mark the turn
`interrupted` — never a normal completion, never a failure.

## 4. Run-state machine (`core/state-machine.ts`)

Fine-grained states: `idle, preparing, model_requesting, model_streaming,
model_done, tool_executing, waiting_for_permission, waiting_for_user,
retrying, compacting, cancelling`. A derived coarse lifecycle (`running`,
`waitingForPermission`, …) is what the protocol surfaces.

Guard rails:

- invalid transitions are no-ops, except `FORCE_IDLE` which always applies;
- once `cancelling`, only terminal events apply;
- returning to idle via a drain-eligible event (`AGENT_ENDED`, `RUN_FAILED`,
  `COMPACT_FAILED`, `FORCE_IDLE`) auto-drains the queued user inputs.

## 5. Context pipeline (`context/pipeline.ts`)

`interface ContextInterceptor { name; priority; intercept(ctx) }`, sorted
descending by priority. Today: `env` (2000) injects date/system reminders,
`system` (1500) writes the base agent prompt. New context sources are new
interceptors — no `buildPrompt()` monolith to re-edit.

## 6. Tool governance (`tools/orchestrator.ts` + `permissions/`)

```
PreToolUse hooks (deny > ask > allow; crashed hook ⇒ ask)
  → permission chain:
      deny rules (any-segment match)
      dangerous-command backstop (before allow rules)
      allow rules (shell: EVERY segment covered by the union of rules;
                   injection constructs like $( ) ` ` <( always fail)
      dangerous-command backstop (whole command + per segment)
      ask rules
      mode: plan / acceptEdits / bypassPermissions / dontAsk
      default: ask (read-only tools pass)
  → approval (reverse request; may remember session/always)
  → execute with streaming → PostToolUse / PostToolUseFailure hooks
```

Denials are results, not exceptions — the reason returns to the model.

## 7. Models (`models/`)

A unified internal message format with two adapters:

- **chat** (`adapters/chat.ts`): OpenAI-compatible `/chat/completions` SSE.
  Streams `content`, `reasoning_content` (DeepSeek/GLM style), assembles
  incremental `tool_calls`, requests `stream_options.include_usage` and
  auto-retries without it on HTTP 400. The stream is read to the end before
  `done` is emitted because OpenAI sends the usage chunk *after*
  `finish_reason`.
- **anthropic** (`adapters/anthropic.ts`): native `/v1/messages` SSE with
  text/thinking/tool_use block assembly.

`ModelGateway` resolves `provider/model` refs against layered settings and
caches adapters. `ModelStreamer` is the minimal interface the turn runner and
compactor depend on — tests script it.

## 8. Hooks (`hooks/bus.ts`)

16 events following the community vocabulary: `PreToolUse, PostToolUse,
PostToolUseFailure, UserPromptSubmit, Stop, StopFailure, SessionStart,
SessionEnd, SubagentStart, SubagentStop, PreCompact, PostCompact,
PermissionRequest, PermissionDenied, ConfigChange, Notification`.

Two flavours: in-process handlers and command hooks from settings
(`{ "PreToolUse": [{ "command": "node guard.js" }] }` — payload on stdin,
JSON decision on stdout). Merge policy: **strictest wins** (`deny > ask >
allow`); a hook that fails to execute sets `anyFailed` and callers treat it
as *ask* — guards fail closed.

## 9. Persistence (`storage/`)

One JSONL file per thread: the conversation body as an append-only event log
(`meta`, `turn-started/ended`, `user-msg`, `agent-msg`, `reasoning`,
`tool-call`, `tool-result`, `plan`, `compacted`, `usage`). Deltas are never
written. `compacted` events are permanent — replay applies the history
replacement. Torn tail lines are dropped. `ThreadStore` is an interface;
`JsonlThreadStore` is the local implementation.

## 10. Compaction (`compact/compactor.ts`)

Triggered when `max(estimated, provider-reported) tokens` exceeds a fraction
of the model's context window. The same model summarizes the dropped prefix;
on failure it preserves the original history. Tool pairs are never
split at the cut boundary; consecutive compactions are capped to prevent
loops.

## 11. apply_patch (`tools/defs/apply-patch/`)

Parser + applier for the codex-style format (`Update/Add/Delete File`,
`Move to`, `@@` anchors, `\***` escaping). Hunks are located by context
lines — exact match first, whitespace-insensitive second — never by line
number. Each patch application produces a unified-diff preview for the
transcript. See NOTICE for provenance.

## 12. Protocol

Documented separately in [PROTOCOL.md](PROTOCOL.md).

## 13. Desktop public preview v0.0.1

The sole renderer source lives at `packages/desktop/src/renderer/src`. Build and CI need only this repository. React is bundled as an IIFE for the local file page, Tailwind v4 compiles shared tokens, and main/preload are separate CJS bundles.

`bridge.ts` owns thread snapshots and a persistent event subscription. Switching views does not stop a runner. `useConversationScroll.ts` remembers reading positions per conversation, pauses following for active browsing, and resumes only when the user returns to the latest content. Thinking, plan, tools and file changes share a collapsible activity area; approval/input requests and model milestone replies remain visible.

ProjectStore persists user-authored projects in SMALT_HOME/projects.json. Conversations carry projectId and project instructions are injected into model context. Archive, restore and delete validate conversation ids; deleting a project preserves conversations and deleting a conversation preserves workspace files.

A conversation retains its PermissionService while running. Live permission reconfiguration wakes eligible pending checks without replacing the runner. Batch approvals bind to exact tool ids/inputs and expire with the model batch. Category grants persist as conversation metadata, subject to hard boundaries, risk checks and deny rules.

DesktopTray owns native residency. Closing the window hides it, clicking the tray restores it, and explicitly exiting allows Electron shutdown and tool-process cleanup. API keys entered through desktop settings use system safeStorage encryption when available; otherwise they remain in memory for that run.

`assets/smalt.svg` is the sole logo source. The build generates PNG/ICO, and `after-pack.cjs` embeds canonical icons plus SmaltCode identity/version in the Windows PE. Startup, tray lifecycle and installer/application versions and icon resources are packaging gates.

Text and Markdown can be previewed in the app; unsupported document formats can be revealed in Explorer. MCP, goals, scheduling and Office-native previews are not shipped as complete desktop features in this preview.
