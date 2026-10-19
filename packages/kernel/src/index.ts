/**
 * @smalt/kernel — the smalt agent kernel.
 *
 * Public surface: kernel assembly, protocol types, storage, models,
 * permissions, hooks, tools, and the turn runner.
 */

export { Kernel, type ClientPort, type KernelOptions } from './core/kernel.js';
export { ThreadManager } from './core/thread-manager.js';
export { TurnRunner, type TurnRunnerDeps, type TurnOutcome } from './core/turn-runner.js';
export { ThreadRuntime } from './core/thread.js';
export {
  SessionRunStateMachine,
  DRAIN_ELIGIBLE_IDLE_EVENTS,
  type RunState,
  type RunEvent,
} from './core/state-machine.js';
export { baseSystemPrompt } from './core/prompts.js';
export { VERSION } from './version.js';

export * from './protocol/types.js';
export {
  RpcError,
  RpcErrorCode,
  decodeLine,
  encodeMessage,
  isRequest,
  isNotification,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from './protocol/rpc.js';
export {
  Peer,
  StdioTransport,
  createStdioPeer,
  createPeerPair,
  createTransportPair,
  type Transport,
  type RequestHandler,
} from './protocol/connection.js';

export {
  loadSettings,
  updateUserSettingsFile,
  apiKeyFor, normalizeEndpoint,
  smaltHome,
  resolveModelRef,
  resolveWorkspacePath,
  BUILTIN_PROVIDERS,
  type Settings,
  type ProviderConfig,
  type ModelRef,
} from './config/settings.js';

export { ModelGateway } from './models/gateway.js';
export { ChatCompletionsAdapter, toChatWireMessages } from './models/adapters/chat.js';
export { AnthropicAdapter } from './models/adapters/anthropic.js';
export {
  estimateTokens,
  estimateHistoryTokens,
  ModelError,
  type ChatMessage,
  type ContentPart,
  type ModelAdapter,
  type ModelDelta,
  type ModelRequest,
  type ToolCall,
  type ToolSpec,
  type WireApi,
} from './models/types.js';

export { PermissionService, globMatch, type PermissionDecision, type PermissionCheckInput } from './permissions/service.js';
export {
  commandAllowedBy,
  commandMatchesAny,
  dangerousCommandCheck,
  parseRule,
  PERMISSION_MODES,
  toolClass,
  type PermissionMode,
  type PermissionRule,
  type RuleSource,
} from './permissions/rules.js';

export { HookBus, HOOK_EVENTS, type HookEvent, type HookDecision, type HookResult, type CommandHookConfig, type HookContext } from './hooks/bus.js';

export { ToolRegistry, defaultTools } from './tools/registry.js';
export { killAllToolProcesses } from './tools/defs/shell.js';
export { ToolOrchestrator, type OrchestratorDeps, type ToolRunOutcome } from './tools/orchestrator.js';
export type { ToolDefinition, ToolEvent, ToolRunContext } from './tools/types.js';
export { parsePatch, PatchParseError, type PatchFile, type PatchHunk, type PatchLine } from './tools/defs/apply-patch/parser.js';
export { applyPatch, ApplyError, type AppliedChange, type ApplyReport } from './tools/defs/apply-patch/apply.js';

export { ContextPipeline, envInterceptor, systemInterceptor, type ContextInterceptor, type TurnContext } from './context/pipeline.js';
export { isInsideWorkspace, isSensitivePath, sensitivePaths, realPathOf, isNetworkPath } from './tools/workspace-guard.js';
export { ensureProjectTrust, isProjectTrusted, hasProjectSettings, trustProject, untrustProject } from './config/trust.js';
export { Compactor, type CompactOptions, type CompactResult } from './compact/compactor.js';
export { JsonlThreadStore } from './storage/jsonl.js';
export { replayEvents, type StoreEvent, type ThreadStore, type ReplayedThread } from './storage/thread-store.js';
export { newId, nowIso, truncate, unifiedDiff, errorMessage } from './util.js';
