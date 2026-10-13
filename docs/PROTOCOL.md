# SmaltCode kernel protocol (v1)

Newline-delimited JSON-RPC 2.0 over stdio (`smalt serve`). One JSON value per
line, UTF-8. Responses may arrive in any order; correlate by `id`.

## Requests (client → kernel)

### initialize

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client","version":"0.0.1"}}}
← {"jsonrpc":"2.0","id":1,"result":{"kernelInfo":{"name":"smalt-kernel","version":"0.0.1"},"capabilities":{"approvals":true,"userInput":true,"steer":true,"interrupt":true,"compaction":true},"protocolVersion":1}}
```

### thread/start · thread/resume · thread/list · thread/read · thread/archive

```json
→ {"method":"thread/start","params":{"cwd":"/home/me/project","model":"deepseek/deepseek-chat","title":"optional","permissionMode":"default"}}
← {"result":{"threadId":"th_xxx","meta":{...ThreadMeta}}}

→ {"method":"thread/list"}
← {"result":{"threads":[{...ThreadMeta}, ...]}}

→ {"method":"thread/read","params":{"threadId":"th_xxx"}}
← {"result":{"meta":{...},"items":[{...Item}, ...],"status":{...}}}
```

### turn/start

Runs a full turn to completion (streaming arrives via notifications below).
If a turn is already running the input is **queued** and drained
automatically; the response returns `{"turnId":"queued", ...}` immediately.

```json
→ {"method":"turn/start","params":{"threadId":"th_xxx","input":"fix the failing test"}}
← {"result":{"turnId":"turn_xxx","interrupted":false,"failed":false,
              "assistantText":"...","usage":{"inputTokens":812,"outputTokens":94}}}
```

### turn/steer · turn/interrupt

```json
→ {"method":"turn/steer","params":{"threadId":"th_xxx","message":"also check the types"}}
← {"result":{"queued":true}}

→ {"method":"turn/interrupt","params":{"threadId":"th_xxx"}}
← {"result":{"interrupted":true}}
```

## Reverse requests (kernel → client; the client MUST respond)

```json
→ {"jsonrpc":"2.0","id":41,"method":"item/requestApproval",
   "params":{"itemId":"appr_xxx","threadId":"th_xxx","tool":"shell",
             "title":"$ npm test","detail":"No rule allows `shell` — the secure default is to ask",
             "input":{"command":"npm test"}}}
← {"jsonrpc":"2.0","id":41,"result":{"decision":"allow","remember":"always"}}
```

`decision`: `allow | deny`. `remember`: `session | always | omitted`.
`deny` may carry a `reason` that is shown to the model.

```json
→ {"method":"item/requestUserInput","params":{"itemId":"ui_xxx","threadId":"th_xxx",
    "question":"Which database do you target?","options":["postgres","sqlite"]}}
← {"result":"postgres"}
```

## Notifications (kernel → client)

| method | payload |
|---|---|
| `thread/started` | `{threadId, meta}` |
| `thread/status/changed` | `{threadId, lifecycle, state, queuedMessages}` |
| `thread/tokenUsage/updated` | `{threadId, usage: ThreadTokenUsage}` |
| `thread/compacted` | `{threadId, summary}` |
| `turn/started` | `{threadId, turnId}` |
| `turn/completed` | `{threadId, turnId, interrupted?, summary: {durationMs, toolCount, fileCount, usage}}` |
| `turn/failed` | `{threadId, turnId, error}` |
| `item/started` · `item/completed` | `{item: Item}` |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` |
| `item/reasoning/textDelta` | `{threadId, turnId, itemId, delta}` |
| `item/commandExecution/outputDelta` | `{threadId, turnId, itemId, delta}` |

`Item` shapes are defined in `packages/kernel/src/protocol/types.ts` and
exported from `@smalt/kernel`.

## Error codes

Standard JSON-RPC (`-32700/-32600/-32601/-32602/-32603`) plus `-32000`
(kernel error), `-32001` (timeout), `-32002` (cancelled).

## Example session

```
→ initialize
→ thread/start                    ← {threadId}
→ turn/start {input:"list files"} ← (streams)
  ← turn/started
  ← item/completed (userMessage)
  ← item/completed (commandExecution: ls)
  ← item/agentMessage/delta ×N
  ← item/completed (agentMessage)
  ← thread/tokenUsage/updated
  ← turn/completed
← turn/start result
```

## Desktop integration (public preview v0.0.1)

- `thread/rename {threadId, title}`, `thread/pin {threadId, pinned}` → `{meta}`.
- `thread/settings/update {threadId, model?, permissionMode?}` → `{meta}`. Model changes require an idle task; permission changes are allowed while running.
- `thread/compact/start {threadId}` → `{compacted, reason?}`. Runs real compaction while idle; keeps original history on summary failure.
- `thread/updated {threadId, meta}` is emitted after metadata changes and turns. Metadata persists pin state, permission mode and last outcome.
- Items can have `blocked` status. A failed or rejected file write does not create an artifact.
- Approval requests also carry `riskLevel` and `suggestedRule`. Session rules apply to the requesting thread; permanent rules are persisted by the host.
- Text/reasoning deltas identify an item with `itemId`. Tool output deltas are emitted while the command runs.
- Interrupted partial text is saved as a failed item; pending approval/input requests are cancelled on interrupt.
- Goal methods are not advertised because the goal evaluator is not implemented.
- Automatic retry is limited to two retries at 500/1000 ms before any visible output. Authentication/quota failures and partially emitted responses are not retried.

### Desktop-only preload methods

The renderer exposes no Node APIs. Its audited host methods are `call`, `onNotify`, `onApproval`, `onInput`, `onResolved`, `respondApproval`, `respondInput`, `pickFolder`, `pickFiles`, `loadSettings`, `saveSettings`, `testProvider`, `file`, and `windowControl`.
File previews and reveal actions are rechecked against the thread workspace and sensitive-path guard in main.
Only the exact application main-frame URL may invoke these handlers.

## Projects and live approvals (public preview v0.0.1)

- thread/list accepts includeArchived. thread/archive keeps history; thread/restore returns metadata; thread/delete permanently removes the conversation log, leaving workspace files intact.
- project/list, project/create, project/update and project/delete manage user-authored projects (name, instructions, optional cwd). thread/start accepts projectId; thread/project/update moves a conversation (null removes membership). Deleting a project moves its conversations back to the ordinary list.
- thread/settings/update permissionMode is effective while running; model changes and project moves still require an idle conversation. thread/permissions/reset revokes remembered conversation rules/categories, preserving its selected mode and global rules.
- ApprovalDecision.scope: operation (default), batch (only exact input operations in the visible batch), category (normal operations of the same class in this conversation). Category grants persist in ThreadMeta.approvedCategories and may be revoked. deny rules, explicitly requested approval, dangerous commands, outside-workspace reads and hard boundaries stay effective.
- ApprovalRequest includes category, categoryLabel, and an optional batch operation list. Live policy changes can resolve an eligible pending approval; the client receives smalt:resolved so the card disappears.
- No fixed turn-step cap by default. Hosts may explicitly set SMALT_MAX_STEPS to a positive integer; interruption and context compaction remain active.
