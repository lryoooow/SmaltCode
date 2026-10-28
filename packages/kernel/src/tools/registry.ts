import { applyPatchTool } from './defs/apply-patch/tool.js';
import { askUserTool } from './defs/ask-user.js';
import { planTool } from './defs/plan.js';
import { readTool } from './defs/read.js';
import { globTool, grepTool } from './defs/search.js';
import { shellTool } from './defs/shell.js';
import { writeTool } from './defs/write.js';
import type { ToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private scopeFilter?: (name:string,context:{cwd:string;threadId:string})=>boolean;
  private inputGuard?: (name:string,input:unknown,context:{cwd:string;threadId:string})=>string|undefined;
  setInputGuard(guard:(name:string,input:unknown,context:{cwd:string;threadId:string})=>string|undefined):void { this.inputGuard=guard; }
  checkInput(name:string,input:unknown,context:{cwd:string;threadId:string}):string|undefined { return this.inputGuard?.(name,input,context); }
  /** Host-owned execution target gate; also applies to tools registered later by connectors. */
  setScopeFilter(filter:(name:string,context:{cwd:string;threadId:string})=>boolean):void { this.scopeFilter=filter;for(const tool of this.list())this.register(tool); }

  constructor(initial?: ToolDefinition[]) {
    for (const tool of initial ?? defaultTools()) this.register(tool);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, this.scopeFilter?{...tool,available:context=>(!tool.available||tool.available(context))&&(!this.scopeFilter||this.scopeFilter(tool.name,context))}:tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  unregister(name: string): void { this.tools.delete(name); }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  specs(context?: { cwd: string; threadId: string }) {
    return this.list().filter(tool => !tool.available || !!context && tool.available(context)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.external ? t.inputSchema : { ...t.inputSchema, properties: { ...(t.inputSchema.properties as object), recoveryOf: { type: 'string', description: 'Optional earlier tool-call ID from this turn: link native grep/read/glob replacing an unavailable shell utility, or a program+args rerun of the exact same check and cwd. Different scope, skipped tests, failed alternatives and denied operations cannot be cleared.' } } },
    }));
  }
}

export function defaultTools(): ToolDefinition[] {
  return [
    readTool,
    writeTool,
    applyPatchTool,
    shellTool,
    globTool,
    grepTool,
    planTool,
    askUserTool,
  ];
}
