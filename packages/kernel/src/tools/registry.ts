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

  constructor(initial?: ToolDefinition[]) {
    for (const tool of initial ?? defaultTools()) this.register(tool);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  specs() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
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
