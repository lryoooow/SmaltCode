import type { ContextReference, ContextInspection } from '../shared/context.js';

export async function inspectReferences(refs: ContextReference[], load: (ref: ContextReference) => Promise<{ text: string; digest?: string; format?: string; warnings?: string[]; source: string; label: string }>): Promise<ContextInspection[]> {
  const entries: ContextInspection[] = [];
  for (const ref of refs) {
    const selected = ref.start !== undefined || ref.end !== undefined;
    const entry: ContextInspection = { path: ref.path, label: ref.label ?? ref.path, source: '', kind: ref.path.startsWith('source:') ? 'source' : ref.path.startsWith('ssh-ref:') ? 'ssh' : ref.path.startsWith('memory:') ? 'memory' : ref.path.startsWith('feedback:') ? 'feedback' : ref.path.startsWith('skill:') ? 'skill' : ref.path.startsWith('attachment:') ? 'attachment' : 'workspace', selected, valid: false, warnings: [] };
    try {
      const file = await load(ref);
      Object.assign(entry, { source: file.source, label: file.label, digest: file.digest, format: file.format, warnings: file.warnings ?? [], totalCharacters: file.text.length });
      if (ref.digest && ref.digest !== file.digest) throw new Error(selected ? '选区来源已变化，请刷新原文并重新选择' : '来源已变化，请核对当前版本后明确更新引用');
      if (selected && (!Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start! < 0 || ref.end! <= ref.start! || ref.end! > file.text.length || !ref.digest || ref.digest !== file.digest)) throw new Error('选区已失效，请重新选择');
      if (file.format === 'image' && selected) throw new Error('图片不支持文本选区');
      const limit = entry.kind === 'skill'||ref.path.startsWith('ssh-ref:') ? file.text.length : 24000;
      const text = selected ? file.text.slice(ref.start, ref.end) : file.text.slice(0, limit);
      Object.assign(entry, { valid: true, characters: text.length, truncated: !selected && text.length < file.text.length, excerpt: text.slice(0, 3200), startLine: selected ? file.text.slice(0, ref.start).split('\n').length : undefined, endLine: selected ? file.text.slice(0, ref.end).split('\n').length : undefined });
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    entries.push(entry);
  }
  return entries;
}
