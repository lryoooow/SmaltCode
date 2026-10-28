import type { ToolDefinition } from '@smalt/kernel';
import { executionAssessment } from '../../../kernel/src/protocol/assessment.js';
import type { ProcessManager } from './process-manager.js';

export function backgroundShell(base: ToolDefinition, manager: ProcessManager): ToolDefinition {
  return { ...base,
    description: base.description + ' Desktop only: background=true starts a managed persistent process (no foreground timeout). Use for servers/long jobs; inspect with process_read and stop with process_stop. A launch is not a successful test result. Closing a view does not stop it; exiting the app does.',
    inputSchema: { ...base.inputSchema, properties: { ...(base.inputSchema.properties as object), background: { type: 'boolean' }, title: { type: 'string', maxLength: 100 } } },
    async *run(input, context) {
      const value = input as import('../shared/processes.js').ProcessLaunch & { background?: boolean };
      if (!value.background) { yield* base.run(input, context); return; }
      if (context.signal.aborted) { yield { type: 'result', text: 'Interrupted', isError: true }; return; }
      try {
        const process = await manager.start(context.threadId, value, 'model');
        const probe = executionAssessment(process.command, '', 0, value.command ? 'shell' : 'process', process.cwd);
        yield { type: 'result', text: JSON.stringify({ process, notice: '进程正在后台启动/运行，尚未取得退出结果。可用 process_read 查看真实输出；process_stop 单独停止。' }), assessment: { ...probe, kind: probe.check ? 'unverified' : 'success', exitCode: null, summary: '后台进程已登记，退出结果尚未验证' } };
      } catch (error) { yield { type: 'result', text: error instanceof Error ? error.message : String(error), isError: true }; }
    },
  };
}
export function processTools(manager: ProcessManager): ToolDefinition[] {
  return [{
    name: 'process_read', description: 'List this conversation’s managed processes, or read one bounded output tail and its actual exit state. Cannot access other conversations or write terminal input.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 80 } }, additionalProperties: false }, subject: input => String((input as { id?: string }).id ?? 'list'), summarize: () => '查看后台进程',
    async *run(input, context) {
      const id = (input as { id?: string }).id;
      if (!id) { yield { type: 'result', text: JSON.stringify(manager.list(context.threadId)) }; return; }
      try {
        const result = manager.read(context.threadId, id), process = result.process;
        const final = ['exited', 'failed', 'stopped', 'interrupted'].includes(process.state);
        const assessment = executionAssessment(process.command, result.output.data + (process.state === 'stopped' || process.state === 'interrupted' ? '\n[interrupted]' : ''), process.exitCode ?? null, 'process', process.cwd);
        if (!final) Object.assign(assessment, { kind: assessment.check ? 'unverified' : 'success', summary: '后台进程仍在运行，尚无退出结果' });
        yield { type: 'result', text: JSON.stringify(result), assessment, isError: final && assessment.kind === 'error' };
      } catch (error) { yield { type: 'result', text: error instanceof Error ? error.message : String(error), isError: true }; }
    },
  }, {
    name: 'process_stop', description: 'Stop one managed process belonging to this conversation, including its child processes. Never accepts OS process IDs.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 80 } }, required: ['id'], additionalProperties: false }, subject: input => 'stop-owned-process ' + (input as { id: string }).id, summarize: () => '停止后台进程',
    async *run(input, context) { try { await manager.stop(context.threadId, (input as { id: string }).id); yield { type: 'result', text: '该进程已停止；其他进程与对话继续运行。' }; } catch (error) { yield { type: 'result', text: error instanceof Error ? error.message : String(error), isError: true }; } },
  }];
}
