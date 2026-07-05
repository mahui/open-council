/**
 * Human-readable rendering of configuration validation failures.
 *
 * ConfigLoader parses YAML through zod schemas (TS-04), so a malformed config
 * surfaces as a raw `ZodError` whose default `.message` is a JSON blob. This
 * helper turns that into per-field Chinese guidance so users can actually fix
 * their config instead of silently falling back to env-discovered models.
 */

import { ZodError, type ZodIssue } from 'zod';

/**
 * Format a config-load error into a readable multi-line message.
 * ZodError → one line per issue ("字段路径: 期望 X 实际 Y"); other errors are
 * passed through as-is.
 */
export function formatConfigError(err: unknown, filePath?: string): string {
  const where = filePath ? `配置文件 ${filePath}` : '配置';

  if (err instanceof ZodError) {
    const lines = [`${where} 校验失败，发现 ${err.issues.length} 处问题：`];
    for (const issue of err.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(根)';
      lines.push(`  • ${path}: ${describeIssue(issue)}`);
    }
    return lines.join('\n');
  }

  if (err instanceof Error) {
    return `${where} 加载失败：${err.message}`;
  }

  return `${where} 加载失败：${String(err)}`;
}

function describeIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `期望 ${issue.expected}，实际 ${issue.received}`;
    case 'invalid_enum_value':
      return `期望以下之一 [${issue.options.join(', ')}]，实际 "${String(issue.received)}"`;
    case 'unrecognized_keys':
      return `存在未知字段: ${issue.keys.join(', ')}`;
    case 'invalid_literal':
      return `期望字面量 ${JSON.stringify(issue.expected)}`;
    case 'too_small':
      return `值过小（${issue.message}）`;
    case 'too_big':
      return `值过大（${issue.message}）`;
    default:
      return issue.message;
  }
}
