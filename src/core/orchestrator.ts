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
import { buildBroadcastPrompt, buildSynthesisPrompt, buildReviewPrompt, buildCrossExaminePrompt, extractDivergencePoints } from './prompt-builder.js';
import { Anonymizer } from './anonymizer.js';
import { parseReviewResponse } from './score-parser.js';
import { calculateConsensus } from './consensus.js';
import { generateRoles, resolveModel } from './role-generator.js';
import { buildCompressionPlan, applyFallbackCompression, type ScoredResponse } from './compression.js';

const PHASE_SEQUENCES: Record<Exclude<DebateMode, 'auto'>, DebatePhase[]> = {
  quick:   ['route', 'broadcast'],
  compare: ['route', 'broadcast', 'synthesis'],
  debate:  ['route', 'broadcast', 'review', 'consensus', 'synthesis'],
};

const MAX_DEBATE_ROUNDS = 3;
const CONSENSUS_THRESHOLD = 0.6;

export class Orchestrator {
  constructor(
    private adapter: InvocationAdapter,
    private renderer: Renderer,
    private availableModels: ModelConfig[],
    private defaultChairman?: string,
  ) {}

  async run(question: string, options: RunOptions): Promise<Session> {
    const session = this.createSession(question, options);

    if (session.resolved_mode === 'debate') {
      await this.runDebateLoop(session);
    } else {
      const phases = PHASE_SEQUENCES[session.resolved_mode as Exclude<DebateMode, 'auto'>]
        ?? PHASE_SEQUENCES.compare;
      await this.runPhases(phases, session);
    }

    session.status = session.status === 'failed' ? 'failed' : 'completed';
    session.completed_at = new Date().toISOString();
    session.total_elapsed_ms = Date.now() - new Date(session.created_at).getTime();

    return session;
  }

  /** Multi-round debate: broadcast → review → consensus → [cross-examine loop] → synthesis */
  private async runDebateLoop(session: Session): Promise<void> {
    // Round 0: Initial broadcast
    await this.runPhases(['route', 'broadcast', 'review', 'consensus'], session);
    if (session.status === 'failed') return;

    // Iterative rounds: cross-examine if consensus is low
    let round = 0;
    while (round < MAX_DEBATE_ROUNDS - 1) {
      const consensus = session.consensus;
      if (!consensus || consensus.consensus_score >= CONSENSUS_THRESHOLD) break;

      round++;
      this.renderer.onDegradation({
        phase: 'consensus',
        reason: `Consensus low (${consensus.consensus_score.toFixed(2)})`,
        impact: `Round ${round + 1}: initiating cross-examination`,
      });

      // Cross-examine: agents see each other's responses and divergence points, then revise
      await this.executeCrossExamine(session, round);
      if (session.status === 'failed') break;

      // Re-review the new responses
      session.status = 'reviewing';
      this.renderer.onPhaseStart('review', 0, 3);
      try {
        await this.executeReview(session);
      } catch (err) {
        this.handlePhaseError('review', session, err);
        if (session.status === 'failed') break;
      }

      // Re-calculate consensus
      this.renderer.onPhaseStart('consensus', 1, 3);
      try {
        this.executeConsensus(session);
      } catch (err) {
        this.handlePhaseError('consensus', session, err);
      }
    }

    // Pre-Synthesis Compression (if needed)
    if (session.status !== 'failed') {
      this.executePreSynthesisCompression(session);
    }

    // Final: synthesis
    if (session.status !== 'failed') {
      session.status = 'synthesizing';
      this.renderer.onPhaseStart('synthesis', 0, 1);
      try {
        await this.executeSynthesis(session);
      } catch (err) {
        this.handlePhaseError('synthesis', session, err);
      }
    }
  }

  private async runPhases(phases: DebatePhase[], session: Session): Promise<void> {
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
    if (this.availableModels.length < 2) return 'quick';

    const isShort = question.length < 20;
    const isQuickKeyword = /^(hi|hello|hey|你好|帮我|翻译)\b/i.test(question.trim());

    // Short greetings / trivial → quick
    if (isShort && isQuickKeyword) return 'quick';

    // Multiple models available → default to debate (full pipeline with review + consensus)
    // Use compare only for very short simple questions
    if (question.length < 15) return 'compare';

    return 'debate';
  }

  private async executePhase(phase: DebatePhase, session: Session): Promise<void> {
    switch (phase) {
      case 'route':
        await this.executeRoute(session);
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
      case 'cross_examine':
        await this.executeCrossExamine(session, 1);
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

  private async executeRoute(session: Session): Promise<void> {
    const stage = this.createStage('route');

    const models = this.availableModels.filter(m => m.enabled);
    const chairmanModel = this.defaultChairman
      ? models.find(m => m.name === this.defaultChairman) ?? models[0]
      : models[0];

    // Generate roles AND model assignments in one AI call
    const agentCount = Math.max(models.length, 3); // at least 3 perspectives
    const roles = await generateRoles(
      session.question,
      agentCount,
      this.adapter,
      models,
    );

    session.agents = roles.map(role => {
      const model = resolveModel(role, models);
      return {
        agent_id: randomUUID(),
        config: model,
        role: `${role.icon} ${role.name}`,
        role_description: role.description,
        system_prompt: role.system_prompt,
        is_chairman: model === chairmanModel,
        is_devil_advocate: false,
      };
    });

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
          try {
            const onChunk = (chunk: string) => this.renderer.onAgentProgress(agent, chunk);
            const result = await this.adapter.invoke(agent.config, prompt, onChunk);
            this.renderer.onAgentComplete(agent, result);
            results.push(this.toInvocation(agent, result, prompt));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const failResult: InvocationResult = {
              response: '', elapsed_ms: Date.now() - new Date(session.created_at).getTime(),
              invocation_mode: 'api', timed_out: true,
            };
            this.renderer.onAgentComplete(agent, { ...failResult, response: `[Error] ${msg.split('\n')[0]?.substring(0, 100)}` });
            results.push({
              agent_id: agent.agent_id,
              model_name: agent.config.name,
              role: agent.role,
              prompt,
              response_raw: '',
              result: failResult,
              timed_out: true,
            });
          }
        }
        return results;
      }),
    );

    stage.invocations = allInvocations.flat();
    const succeeded = stage.invocations.filter(i => !i.timed_out && i.response_raw);
    if (succeeded.length === 0) {
      throw new Error('All agents failed');
    }
    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeCrossExamine(session: Session, roundNumber: number): Promise<void> {
    const stage = this.createStage('cross_examine');

    session.status = 'cross_examining';
    this.renderer.onPhaseStart('cross_examine', 0, 3);

    // Get the latest broadcast responses
    const broadcastStages = session.stages.filter(s => s.phase === 'broadcast' || s.phase === 'cross_examine');
    const latestBroadcast = broadcastStages[broadcastStages.length - 1];
    if (!latestBroadcast) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    const validInvocations = latestBroadcast.invocations.filter(i => !i.timed_out && i.response_raw);
    if (validInvocations.length < 2) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    // Extract divergence points from consensus
    const divergencePoints = session.consensus
      ? extractDivergencePoints(
          session.consensus,
          validInvocations.map(inv => ({ role: inv.role, response: inv.response_raw })),
        )
      : [];

    // Each agent revises their response based on others' perspectives
    const allInvocations = await Promise.all(
      session.agents.map(async (agent) => {
        const ownInv = validInvocations.find(inv => inv.agent_id === agent.agent_id);
        if (!ownInv) return null;

        const otherResponses = validInvocations
          .filter(inv => inv.agent_id !== agent.agent_id)
          .map(inv => ({ role: inv.role, response: inv.response_raw }));

        const prompt = buildCrossExaminePrompt(
          session.question,
          agent.role,
          ownInv.response_raw,
          otherResponses,
          divergencePoints,
          roundNumber,
        );

        this.renderer.onAgentStart(agent);
        try {
          const onChunk = (chunk: string) => this.renderer.onAgentProgress(agent, chunk);
          const result = await this.adapter.invoke(agent.config, prompt, onChunk);
          this.renderer.onAgentComplete(agent, result);
          return this.toInvocation(agent, result, prompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.renderer.onAgentComplete(agent, {
            response: `[Error] ${msg.split('\n')[0]?.substring(0, 100)}`,
            elapsed_ms: 0, invocation_mode: 'api', timed_out: true,
          });
          return null;
        }
      }),
    );

    stage.invocations = allInvocations.filter((inv): inv is Invocation => inv !== null);
    stage.status = stage.invocations.length > 0 ? 'completed' : 'failed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeSynthesis(session: Session): Promise<void> {
    const stage = this.createStage('synthesis');

    // Find the latest responses (could be from cross_examine rounds or initial broadcast)
    const responseStages = session.stages.filter(
      s => (s.phase === 'cross_examine' || s.phase === 'broadcast') && s.status === 'completed',
    );
    const latestStage = responseStages[responseStages.length - 1];
    if (!latestStage) {
      this.renderer.onDegradation({ phase: 'synthesis', reason: 'No responses found', impact: 'Synthesis skipped' });
      stage.status = 'failed';
      session.stages.push(stage);
      return;
    }

    const responses = latestStage.invocations
      .filter(inv => !inv.timed_out && inv.response_raw)
      .map(inv => ({
        role: inv.role,
        modelName: inv.model_name,
        response: inv.response_raw,
      }));

    if (responses.length === 0) {
      this.renderer.onDegradation({ phase: 'synthesis', reason: 'All agent responses empty', impact: 'Synthesis skipped' });
      stage.status = 'failed';
      session.stages.push(stage);
      return;
    }

    // If only one response, use it directly as synthesis
    if (responses.length === 1) {
      session.synthesis = responses[0]!.response;
      // Notify renderer so __synthesis__ tab shows the result
      const synthAgent = this.makeSynthAgent(session);
      if (synthAgent) {
        this.renderer.onAgentStart(synthAgent);
        this.renderer.onAgentProgress(synthAgent, responses[0]!.response);
        this.renderer.onAgentComplete(synthAgent, {
          response: responses[0]!.response, elapsed_ms: 0,
          invocation_mode: 'api', timed_out: false,
        });
      }
      stage.status = 'completed';
      stage.completed_at = new Date().toISOString();
      session.stages.push(stage);
      return;
    }

    // Use chairman model for synthesis
    const chairman = session.agents.find(a => a.is_chairman) ?? session.agents[0];
    if (!chairman) {
      this.renderer.onDegradation({ phase: 'synthesis', reason: 'No chairman model', impact: 'Synthesis skipped' });
      stage.status = 'failed';
      session.stages.push(stage);
      return;
    }

    const prompt = buildSynthesisPrompt(session.question, responses);

    const synthAgent = this.makeSynthAgent(session)!;
    this.renderer.onAgentStart(synthAgent);
    const onChunk = (chunk: string) => this.renderer.onAgentProgress(synthAgent, chunk);
    const result = await this.adapter.invoke(chairman.config, prompt, onChunk);
    this.renderer.onAgentComplete(synthAgent, result);

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

    // Each agent reviews all responses — output goes to the __review__ tab
    const reviewAgent: Agent = {
      agent_id: '__review__',
      config: session.agents[0]!.config,
      role: '📋 Peer Review',
      role_description: 'Experts evaluating each other\'s responses',
      system_prompt: '',
      is_chairman: false,
      is_devil_advocate: false,
    };
    this.renderer.onAgentStart(reviewAgent);

    const allInvocations: Invocation[] = [];
    for (let i = 0; i < session.agents.length; i++) {
      const agent = session.agents[i]!;
      const prompt = buildReviewPrompt(session.question, anonymized);

      this.renderer.onAgentProgress(reviewAgent, `\n--- ${agent.role} [${agent.config.name}] reviewing... ---\n`);
      try {
        const result = await this.adapter.invoke(agent.config, prompt, (chunk) => {
          this.renderer.onAgentProgress(reviewAgent, chunk);
        });
        this.renderer.onAgentProgress(reviewAgent, `\n✓ ${agent.role} review complete\n`);
        allInvocations.push(this.toInvocation(agent, result, prompt));
      } catch (err) {
        this.renderer.onAgentProgress(reviewAgent, `\n✗ ${agent.role} review failed\n`);
        this.renderer.onDegradation({ phase: 'review', reason: err instanceof Error ? err.message : String(err), impact: `Review by ${agent.config.name} failed` });
      }
    }

    this.renderer.onAgentComplete(reviewAgent, {
      response: `${allInvocations.length} reviews completed`,
      elapsed_ms: Date.now() - new Date(stage.started_at!).getTime(),
      invocation_mode: 'api',
      timed_out: false,
    });

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

  private executePreSynthesisCompression(session: Session): void {
    // Find latest responses
    const responseStages = session.stages.filter(
      s => (s.phase === 'cross_examine' || s.phase === 'broadcast') && s.status === 'completed',
    );
    const latestStage = responseStages[responseStages.length - 1];
    if (!latestStage) return;

    const validInvocations = latestStage.invocations.filter(i => !i.timed_out && i.response_raw);
    const totalChars = validInvocations.reduce((sum, inv) => sum + inv.response_raw.length, 0);

    // Check if compression needed (threshold: 60% of ~100k chars context)
    if (totalChars <= 60_000) return;

    this.renderer.onPhaseStart('pre_synthesis_compression', 0, 1);
    this.renderer.onDegradation({
      phase: 'pre_synthesis_compression',
      reason: `Responses total ${totalChars} chars`,
      impact: `Compressing to fit synthesis context window`,
    });

    // Build scored responses for compression ranking
    const scored: ScoredResponse[] = validInvocations.map(inv => {
      const agent = session.agents.find(a => a.agent_id === inv.agent_id);
      return {
        agentId: inv.agent_id,
        modelName: inv.model_name,
        role: inv.role,
        content: inv.response_raw,
        reviewScore: undefined, // TODO: extract from review stage
        modelPriority: agent?.config.priority ?? 100,
      };
    });

    const plan = buildCompressionPlan(scored, 0.6, 100_000, 2);
    if (!plan.triggered) return;

    const result = applyFallbackCompression(plan);

    // Update invocations with compressed content
    for (const compressed of result.responses) {
      if (!compressed.wasCompressed) continue;
      const inv = latestStage.invocations.find(i => i.agent_id === compressed.agentId);
      if (inv) {
        inv.response_raw = compressed.content;
      }
    }

    const stage = this.createStage('pre_synthesis_compression');
    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private handlePhaseError(phase: DebatePhase, session: Session, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    const event: DegradationEvent = {
      phase,
      reason,
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

  private makeSynthAgent(session: Session): Agent | null {
    const chairman = session.agents.find(a => a.is_chairman) ?? session.agents[0];
    if (!chairman) return null;
    return { ...chairman, agent_id: '__synthesis__', role: 'chairman' };
  }

  private phaseToStatus(phase: DebatePhase): SessionStatus {
    const map: Record<string, SessionStatus> = {
      route: 'routing',
      broadcast: 'broadcasting',
      review: 'reviewing',
      cross_examine: 'cross_examining',
      human_gate: 'human_gate',
      consensus: 'computing_consensus',
      pre_synthesis_compression: 'compressing',
      synthesis: 'synthesizing',
    };
    return map[phase] ?? 'broadcasting';
  }
}
