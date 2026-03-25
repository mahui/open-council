/**
 * council export <sessionId> — Export a session as Markdown to stdout.
 * Thin CLI layer (ARCH-03).
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import type { Session, Stage, Invocation } from '../types/session.js';

interface ExportOptions {
  format?: string;
}

function formatDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function renderInvocation(inv: Invocation): string {
  const timeout = inv.timed_out ? ' **(TIMED OUT)**' : '';
  const elapsed = `${inv.result.elapsed_ms}ms`;
  return (
    `#### ${inv.role} — ${inv.model_name} (${elapsed})${timeout}\n\n` +
    inv.result.response +
    '\n'
  );
}

function renderStage(stage: Stage, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`### Stage ${index + 1}/${total}: ${stage.phase} (${stage.status})\n`);
  if (stage.started_at) lines.push(`- Started: ${formatDate(stage.started_at)}`);
  if (stage.completed_at) lines.push(`- Completed: ${formatDate(stage.completed_at)}`);
  lines.push('');
  for (const inv of stage.invocations) {
    lines.push(renderInvocation(inv));
  }
  return lines.join('\n');
}

function renderMarkdown(session: Session): string {
  const lines: string[] = [];

  lines.push(`# Council Debate: ${session.session_id}\n`);
  lines.push(`> **Question:** ${session.question}\n`);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Mode | ${session.resolved_mode} |`);
  lines.push(`| Status | ${session.status} |`);
  lines.push(`| Created | ${formatDate(session.created_at)} |`);
  if (session.completed_at) {
    lines.push(`| Completed | ${formatDate(session.completed_at)} |`);
  }
  if (session.total_elapsed_ms != null) {
    lines.push(`| Duration | ${session.total_elapsed_ms}ms |`);
  }
  if (session.user_rating != null) {
    lines.push(`| Rating | ${'*'.repeat(session.user_rating)}/5 |`);
  }
  if (session.tags?.length) {
    lines.push(`| Tags | ${session.tags.join(', ')} |`);
  }
  lines.push('');

  lines.push('## Agents\n');
  for (const a of session.agents) {
    const chair = a.is_chairman ? ' **[Chairman]**' : '';
    lines.push(`- **${a.agent_id}**: ${a.config.name} (${a.role})${chair}`);
  }
  lines.push('');

  lines.push('## Debate Stages\n');
  const total = session.stages.length;
  for (const [i, stage] of session.stages.entries()) {
    lines.push(renderStage(stage, i, total));
  }

  if (session.synthesis) {
    lines.push('## Synthesis\n');
    lines.push(session.synthesis);
    lines.push('');
  }

  if (session.consensus) {
    lines.push('## Consensus\n');
    lines.push(`- Score: ${session.consensus.consensus_score}`);
    lines.push(`- Raw agreement: ${session.consensus.raw_agreement}`);
    lines.push(`- Model diversity factor: ${session.consensus.model_diversity_factor}`);
    lines.push('');
  }

  if (session.degradation_events?.length) {
    lines.push('## Degradation Events\n');
    for (const ev of session.degradation_events) {
      lines.push(`- **[${ev.phase}]** ${ev.reason}: ${ev.impact}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function runExport(
  sessionId: string,
  options: ExportOptions,
): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const session = await store.getSession(sessionId);

  if (!session) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exit(1);
  }

  if (options.format === 'json') {
    process.stdout.write(JSON.stringify(session, null, 2) + '\n');
    return;
  }

  process.stdout.write(renderMarkdown(session));
}
