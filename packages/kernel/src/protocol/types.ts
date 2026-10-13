/**
 * Core concept model: Thread → Turn → Item.
 *
 * A Thread is a persisted conversation. A Turn is one unit of work: the user
 * submits input, and the agent keeps working (sampling + tool calls) until it
 * stops. An Item is the smallest observable unit inside a turn — a message, a
 * reasoning block, a command execution, a file change, …
 *
 * Items have a `started → delta* → completed` lifecycle. Deltas are transient
 * (never persisted); completed items are.
 */

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'blocked';

export interface ItemBase {
  id: string;
  threadId: string;
  turnId: string;
  createdAt: string;
  status: ItemStatus;
}

export interface UserMessageItem extends ItemBase {
  kind: 'userMessage';
  text: string;
}

export interface AgentMessageItem extends ItemBase {
  kind: 'agentMessage';
  text: string;
}

export interface ReasoningItem extends ItemBase {
  kind: 'reasoning';
  text: string;
}

export interface CommandExecutionItem extends ItemBase {
  kind: 'commandExecution';
  command: string;
  /** the tool that produced this (shell, read, grep, …) */
  tool?: string;
  exitCode: number | null;
  output: string;
}

export type FileChangeKind = 'add' | 'update' | 'delete';

export interface FileChangeItem extends ItemBase {
  kind: 'fileChange';
  path: string;
  changeKind: FileChangeKind;
  /** unified-diff preview of the change, when applicable */
  diff?: string;
}

export interface PlanStep {
  content: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface PlanItem extends ItemBase {
  kind: 'plan';
  steps: PlanStep[];
}

export interface McpToolCallItem extends ItemBase {
  kind: 'mcpToolCall';
  server: string;
  tool: string;
  arguments: unknown;
  output: string;
}

export interface UserInputRequestItem extends ItemBase {
  kind: 'userInputRequest';
  question: string;
  options?: string[];
}

export type Item =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | PlanItem
  | McpToolCallItem
  | UserInputRequestItem;

export type ItemKind = Item['kind'];

export interface ThreadMeta {
  id: string;
  title: string;
  model: string;
  provider?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** number of completed turns */
  turnCount: number;
  pinned?: boolean;
  projectId?: string;
  archived?: boolean;
  approvedCategories?: Array<'edit' | 'read' | 'shell'>;
  permissionMode?: import('../permissions/rules.js').PermissionMode;
  lastOutcome?: 'completed' | 'failed' | 'interrupted';
}

export interface ProjectMeta {
  id: string;
  name: string;
  instructions: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnInfo {
  id: string;
  threadId: string;
  startedAt: string;
  endedAt?: string;
}

/** Coarse lifecycle projected from the fine-grained run state machine. */
export type ThreadRunLifecycle =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'waitingForPermission'
  | 'waitingForUser'
  | 'compacting'
  | 'retrying'
  | 'cancelling';

export interface ThreadStatus {
  threadId: string;
  lifecycle: ThreadRunLifecycle;
  state: string;
  queuedMessages: number;
}

export interface ThreadTokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** total across the thread, loaded from persistence + this session */
  totalInputTokens: number;
  totalOutputTokens: number;
  contextWindow: number;
  /** rough share of the context window currently occupied (0..1) */
  contextUsage: number;
}

/* ------------------------------------------------------------------ *
 * Approval round-trips (server → client requests)
 * ------------------------------------------------------------------ */

export interface ApprovalRequest {
  itemId: string;
  threadId: string;
  tool: string;
  /** short human-facing summary of what is about to happen */
  title: string;
  /** longer explanation / risky parts */
  detail?: string;
  input: unknown;
  riskLevel?: 'normal' | 'high';
  suggestedRule?: string;
  category?: 'edit' | 'shell' | 'read' | 'other';
  categoryLabel?: string;
  batch?: Array<{ id: string; tool: string; title: string; input: unknown }>;
}

export type ApprovalDecision =
  | { decision: 'allow'; remember?: 'session' | 'always'; scope?: 'operation' | 'category' | 'batch' }
  | { decision: 'deny'; reason?: string };

export interface UserInputRequest {
  itemId: string;
  threadId: string;
  question: string;
  options?: string[];
}

/* ------------------------------------------------------------------ *
 * Protocol method names (JSON-RPC)
 * ------------------------------------------------------------------ */

export const Methods = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadList: 'thread/list',
  threadRead: 'thread/read',
  threadArchive: 'thread/archive',
  threadRestore: 'thread/restore',
  threadDelete: 'thread/delete',
  threadProject: 'thread/project/update',
  projectList: 'project/list',
  projectCreate: 'project/create',
  projectUpdate: 'project/update',
  projectDelete: 'project/delete',
  threadRename: 'thread/rename',
  threadPin: 'thread/pin',
  threadSettings: 'thread/settings/update',
  threadPermissionsReset: 'thread/permissions/reset',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  threadCompact: 'thread/compact/start',
  /* reverse requests (kernel → client) */
  requestApproval: 'item/requestApproval',
  requestUserInput: 'item/requestUserInput',
} as const;

export const Notifications = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadTokenUsage: 'thread/tokenUsage/updated',
  threadCompacted: 'thread/compacted',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnFailed: 'turn/failed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningDelta: 'item/reasoning/textDelta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeDelta: 'item/fileChange/outputDelta',
  log: 'log',
} as const;

export interface InitializeParams {
  clientInfo?: { name: string; version: string };
  cwd?: string;
}

export interface InitializeResult {
  kernelInfo: { name: 'smalt-kernel'; version: string };
  capabilities: {
    approvals: true;
    userInput: true;
    steer: true;
    interrupt: true;
    compaction: true;
  };
  protocolVersion: 1;
}
