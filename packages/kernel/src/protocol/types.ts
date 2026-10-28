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

export type UserReference = { path: string; label?: string };
export type UserPrompt = string | { text: string; displayText?: string; references?: UserReference[]; images?: import('../models/types.js').ImagePart[]; steeringId?: string };
export type SteeringEntry = {
  id: string; revision: number; text: string; references?: UserReference[]; imageCount: number;
  state: 'pending' | 'applied' | 'cancelled' | 'unused'; createdAt: string; updatedAt: string;
  turnId?: string; editable: boolean;
};

export interface UserMessageItem extends ItemBase {
  kind: 'userMessage';
  text: string;
  references?: UserReference[];
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
  assessment?: import('./assessment.js').ExecutionAssessment;
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
  origin?: string;
  resultId?: string;
}

export interface UserInputRequestItem extends ItemBase {
  kind: 'userInputRequest';
  question: string;
  options?: string[];
  answer?: string;
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

export interface ContextNotice {
  turnId: string;
  level: 'info' | 'warning';
  message: string;
  reason?: string;
  beforeTokens?: number;
  afterTokens?: number;
  contextWindow?: number;
  thresholdTokens?: number;
  /** Whole input at the trigger, including system/tool instructions. */
  inputTokens?: number;
}

export interface ThreadMeta {
  /** Desktop-owned automatic files scope; set by the host, never a project association. */
  localSpace?: boolean;
  /** Trusted desktop marker prevents a lost/corrupt remote registry from falling back to local execution. */
  containerTarget?: {profileId:string;context:string;endpoint:string;engineId:string;contextFingerprint:string;containerId:string;name:string;imageId:string;root:string;user:string;startedAt:string;readOnly:boolean;ssh?:{profileId:string;name:string;host:string;port:number;username:string;root:string;fingerprint:string;socket:string}};
  sshTarget?: {profileId:string;name:string;host:string;port:number;username:string;root:string;fingerprint:string};
  id: string;
  /** Set only by the desktop host, preserved after cleanup. */
  collaboration?: { groupId: string; taskId: string; parentThreadId: string };
  remoteOrigin?: { scopeId: string; deviceId: string; hostId: string };
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
  lastError?: string;
  lastAssessment?: import('./assessment.js').TurnAssessment;
  restoredFiles?: Record<string, string>;
  restoredChanges?: Record<string, string[]>;
  usage?: { inputTokens: number; outputTokens: number };
  recovery?: { turnId: string; startedAt: string };
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
  thresholdTokens?: number;
  /** rough share of the context window currently occupied (0..1) */
  contextUsage: number;
}

export interface TurnSummary {
  turnId: string;
  durationMs: number;
  toolCount: number;
  fileCount: number;
  usage: { inputTokens: number; outputTokens: number };
  assessment?: import('./assessment.js').TurnAssessment;
}

/* ------------------------------------------------------------------ *
 * Approval round-trips (server → client requests)
 * ------------------------------------------------------------------ */

export interface ApprovalRequest {
  external?: { server: string; tool: string; origin: string };
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
  turnSteerUpdate: 'turn/steer/update',
  turnSteerCancel: 'turn/steer/cancel',
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
  threadContextNotice: 'thread/context/notice',
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
