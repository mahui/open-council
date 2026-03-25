/**
 * Debate orchestration state machine.
 * Pure logic — no I/O dependencies (ARCH-01).
 * Receives InvocationAdapter and Renderer via dependency injection.
 */

import { randomUUID, createHash } from 'node:crypto';
import type {
  Session, Stage, Invocation, Agent, RunOptions,
  DebateMode, DebatePhase, SessionStatus, DegradationEvent,
} from '../types/session.js';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult } from '../types/provider.js';
import type { Renderer } from '../ui/renderer.js';
import { buildBroadcastPrompt, buildSynthesisPrompt, buildReviewPrompt } from './prompt-builder.js';
import { Anonymizer } from './anonymizer.js';
import { parseReviewResponse } from './score-parser.js';
import { calculateConsensus } from './consensus.js';

const PHASE_SEQUENCES: Record<Exclude<DebateMode, 'auto'>, DebatePhase[]> = {
  quick:   ['route', 'broadcast'],
  compare: ['route', 'broadcast', 'synthesis'],
  debate:  ['route', 'broadcast', 'review', 'consensus', 'synthesis'],
};

export class Orchestrator {
  constructor(
    private adapter: InvocationAdapter,
    private renderer: Renderer,
    private availableModels: ModelConfig[],
    private defaultChairman?: string,
  ) {}

  async run(question: string, options: RunOptions): Promise<Session> {
    // 1. Create session
    const session = this.createSession(question, options);

    // 2. Determine phase sequence
    const phases = PHASE_SEQUENCES[session.resolved_mode as Exclude<DebateMode, 'auto'>]
      ?? PHASE_SEQUENCES.compare;

    // 3. Execute phases sequentially
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!;

      session.status = this.phaseToStatus(phase);
      this.renderer.onPhaseStart(phase, i, phases.length);

      try {
        await this.executePhase(phase, session);
      } catch (err) {
        this.handlePhaseError(phase, session, err);
        if (session.status === 'failed') break;
      }
    }

    // 4. Complete
    session.status = session.status === 'failed' ? 'failed' : 'completed';
    session.completed_at = new Date().toISOString();
    session.total_elapsed_ms = Date.now() - new Date(session.created_at).getTime();

    return session;
  }

  private createSession(question: string, options: RunOptions): Session {
    const resolvedMode = options.mode === 'auto'
      ? this.resolveAutoMode(question)
      : options.mode;

    return {
      session_id: randomUUID(),
      question,
      question_hash: createHash('sha256').update(question).digest('hex').slice(0, 16),
      mode: options.mode,
      resolved_mode: resolvedMode,
      status: 'routing',
      agents: [],
      stages: [],
      tags: options.tags,
      parent_session_id: options.parentSessionId,
      created_at: new Date().toISOString(),
    };
  }

  private resolveAutoMode(question: string): Exclude<DebateMode, 'auto'> {
    // Simple heuristic: longer questions or comparison keywords → compare/debate
    const length = question.length;
    const hasCompareKeywords = /vs\.?|versus|compare|对比|比较|选择/.test(question);
    const hasDebateKeywords = /debate|辩论|讨论|分析|architecture|架构/.test(question);

    if (this.availableModels.length < 2) return 'quick';
    if (hasDebateKeywords && length > 50) return 'debate';
    if (hasCompareKeywords || length > 30) return 'compare';
    return 'compare'; // Default to compare if we have multiple models
  }

  private async executePhase(phase: DebatePhase, session: Session): Promise<void> {
    switch (phase) {
      case 'route':
        this.executeRoute(session);
        break;
      case 'broadcast':
        await this.executeBroadcast(session);
        break;
      case 'synthesis':
        await this.executeSynthesis(session);
        break;
      case 'review':
        await this.executeReview(session);
        break;
      case 'consensus':
        this.executeConsensus(session);
        break;
      case 'human_gate':
      case 'pre_synthesis_compression':
        // Phase 5 features — skip for now
        break;
    }
  }

  private executeRoute(session: Session): void {
    const stage = this.createStage('route');

    // Assign agents from available models
    const models = this.availableModels.filter(m => m.enabled);
    const chairman = this.defaultChairman
      ? models.find(m => m.name === this.defaultChairman) ?? models[0]
      : models[0];

    session.agents = models.map((config, i) => ({
      agent_id: randomUUID(),
      config,
      role: this.assignRole(i),
      role_description: '',
      system_prompt: '',
      is_chairman: config === chairman,
      is_devil_advocate: false,
    }));

    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeBroadcast(session: Session): Promise<void> {
    const stage = this.createStage('broadcast');
    const agents = session.agents;

    // Group by model — same model agents run serially, different models run in parallel
    const groups = this.groupByModel(agents);

    const allInvocations = await Promise.all(
      groups.map(async (group) => {
        const results: Invocation[] = [];
        for (const agent of group) {
          const prompt = buildBroadcastPrompt(
            session.question,
            agent.role,
            agent.system_prompt,
            session.parent_synthesis,
          );

          this.renderer.onAgentStart(agent);
          const result = await this.adapter.invoke(agent.config, prompt);
          this.renderer.onAgentComplete(agent, result);

          results.push(this.toInvocation(agent, result, prompt));
        }
        return results;
      }),
    );

    stage.invocations = allInvocations.flat();
    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeSynthesis(session: Session): Promise<void> {
    const stage = this.createStage('synthesis');

    // Find broadcast results
    const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
    if (!broadcastStage) return;

    const responses = broadcastStage.invocations
      .filter(inv => !inv.timed_out && inv.response_raw)
      .map(inv => ({
        role: inv.role,
        modelName: inv.model_name,
        response: inv.response_raw,
      }));

    if (responses.length === 0) {
      stage.status = 'failed';
      session.stages.push(stage);
      return;
    }

    // If only one response, no need to synthesize
    if (responses.length === 1) {
      session.synthesis = responses[0]!.response;
      stage.status = 'completed';
      stage.completed_at = new Date().toISOString();
      session.stages.push(stage);
      return;
    }

    // Use chairman model for synthesis
    const chairman = session.agents.find(a => a.is_chairman) ?? session.agents[0];
    if (!chairman) {
      stage.status = 'failed';
      session.stages.push(stage);
      return;
    }

    const prompt = buildSynthesisPrompt(session.question, responses);

    this.renderer.onAgentStart(chairman);
    const result = await this.adapter.invoke(chairman.config, prompt);
    this.renderer.onAgentComplete(chairman, result);

    session.synthesis = result.response;
    stage.invocations = [this.toInvocation(chairman, result, prompt)];
    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeReview(session: Session): Promise<void> {
    const stage = this.createStage('review');
    const anonymizer = new Anonymizer();

    // Get broadcast responses
    const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
    if (!broadcastStage) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    const validInvocations = broadcastStage.invocations.filter(i => !i.timed_out && i.response_raw);
    if (validInvocations.length < 2) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    // Anonymize responses
    const agentResponses = validInvocations.map((inv, i) => ({
      agentIndex: i,
      content: inv.response_raw,
    }));
    const anonymized = anonymizer.anonymize(agentResponses);

    // Each agent reviews all responses
    const allInvocations: Invocation[] = [];
    for (const agent of session.agents) {
      const prompt = buildReviewPrompt(session.question, anonymized);

      this.renderer.onAgentStart(agent);
      try {
        const result = await this.adapter.invoke(agent.config, prompt);
        this.renderer.onAgentComplete(agent, result);
        allInvocations.push(this.toInvocation(agent, result, prompt));
      } catch (err) {
        // Individual review failures are non-fatal
        process.stderr?.write?.(`  [!] Review by ${agent.config.name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    stage.invocations = allInvocations;
    stage.status = allInvocations.length > 0 ? 'completed' : 'failed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private executeConsensus(session: Session): void {
    const stage = this.createStage('consensus');

    // Parse review results
    const reviewStage = session.stages.find(s => s.phase === 'review');
    if (!reviewStage || reviewStage.status !== 'completed') {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
    const expectedLabels = (broadcastStage?.invocations ?? [])
      .filter(i => !i.timed_out && i.response_raw)
      .map((_, i) => String.fromCharCode(65 + i));

    // Parse each review response
    const allReviews = reviewStage.invocations
      .filter(inv => inv.response_raw)
      .flatMap(inv => {
        const result = parseReviewResponse(inv.response_raw, expectedLabels);
        return result.reviews;
      });

    // Calculate consensus
    const consensusResult = calculateConsensus(allReviews, session.agents);
    session.consensus = consensusResult;

    this.renderer.onConsensus(consensusResult);

    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private handlePhaseError(phase: DebatePhase, session: Session, err: unknown): void {
    const event: DegradationEvent = {
      phase,
      reason: err instanceof Error ? err.message : String(err),
      impact: '',
    };

    switch (phase) {
      case 'broadcast': {
        const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
        const completed = broadcastStage?.invocations.filter(i => !i.timed_out && i.response_raw) ?? [];
        if (completed.length >= 2) {
          event.impact = `Some agents failed, continuing with ${completed.length} responses`;
        } else if (completed.length === 1) {
          event.impact = 'Only 1 agent succeeded, degrading to quick mode';
          session.resolved_mode = 'quick';
        } else {
          session.status = 'failed';
          event.impact = 'All agents failed';
        }
        break;
      }
      case 'synthesis': {
        event.impact = 'Synthesis failed, outputting best individual response';
        const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
        const best = broadcastStage?.invocations
          .filter(i => !i.timed_out && i.response_raw)
          .sort((a, b) => a.result.elapsed_ms - b.result.elapsed_ms)[0];
        if (best) {
          session.synthesis = best.response_raw;
        }
        break;
      }
      default:
        event.impact = `Phase ${phase} failed, skipping`;
    }

    session.degradation_events = session.degradation_events ?? [];
    session.degradation_events.push(event);
    this.renderer.onDegradation(event);
  }

  private groupByModel(agents: Agent[]): Agent[][] {
    const map = new Map<string, Agent[]>();
    for (const agent of agents) {
      const key = agent.config.name;
      const group = map.get(key);
      if (group) {
        group.push(agent);
      } else {
        map.set(key, [agent]);
      }
    }
    return [...map.values()];
  }

  private createStage(phase: DebatePhase): Stage {
    return {
      phase,
      status: 'running',
      invocations: [],
      started_at: new Date().toISOString(),
    };
  }

  private toInvocation(agent: Agent, result: InvocationResult, prompt: string): Invocation {
    return {
      agent_id: agent.agent_id,
      model_name: agent.config.name,
      role: agent.role,
      prompt,
      response_raw: result.response,
      result,
      timed_out: result.timed_out,
    };
  }

  private assignRole(index: number): string {
    const roles = ['analyst', 'engineer', 'innovator', 'critic', 'pragmatist'];
    return roles[index % roles.length]!;
  }

  private phaseToStatus(phase: DebatePhase): SessionStatus {
    const map: Record<string, SessionStatus> = {
      route: 'routing',
      broadcast: 'broadcasting',
      review: 'reviewing',
      human_gate: 'human_gate',
      consensus: 'computing_consensus',
      pre_synthesis_compression: 'compressing',
      synthesis: 'synthesizing',
    };
    return map[phase] ?? 'broadcasting';
  }
}
