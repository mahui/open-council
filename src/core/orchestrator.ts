/**
 * Debate orchestration state machine.
 * Pure logic — no I/O dependencies (ARCH-01).
 * Receives InvocationAdapter and Renderer via dependency injection.
 */

// Use globalThis.crypto (available in Node ≥20) to avoid importing node:crypto in core/ (ARCH-01)
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/** Simple deterministic hash for session dedup. Not cryptographic — just content fingerprinting. */
function hashQuestion(question: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < question.length; i++) {
    const ch = question.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) * 0x100000000 + (h1 >>> 0)).toString(16).slice(0, 16);
}
import type {
  Session, Stage, Invocation, Agent, RunOptions,
  DebateMode, DebatePhase, SessionStatus, DegradationEvent,
} from '../types/session.js';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult } from '../types/provider.js';
import type { Renderer } from '../types/renderer.js';
import { buildBroadcastPrompt, buildSynthesisPrompt, buildReviewPrompt, buildDevilAdvocateReviewPrompt, buildCrossExaminePrompt, extractDivergencePoints } from './prompt-builder.js';
import { Anonymizer, type AnonymizedResponse } from './anonymizer.js';
import { parseReviewResponse, type ParsedReview } from './score-parser.js';
import { calculateConsensus } from './consensus.js';
import { buildReviewSummaries, type AnswerReviewSummary } from './review-aggregator.js';
import { detectLanguage } from './language.js';
import { generateRoles, resolveModel, defaultRoles, rateModelCapability } from './role-generator.js';
import { resolveMode } from './router.js';
import { buildCompressionPlan, applyFallbackCompression, type ScoredResponse, aggregateReviewScores } from './compression.js';

const PHASE_SEQUENCES: Record<Exclude<DebateMode, 'auto'>, DebatePhase[]> = {
  quick:   ['route', 'broadcast'],
  compare: ['route', 'broadcast', 'synthesis'],
  debate:  ['route', 'broadcast', 'review', 'consensus', 'synthesis'],
};

const MAX_DEBATE_ROUNDS = 3;
/**
 * Cross-examine stop threshold, compared against `agreement_score` (reviewer
 * concordance, independent of provider diversity). Using agreement_score here
 * — rather than the diversity-discounted consensus_score — ensures a
 * single-provider panel can still reach a stop when reviewers actually agree.
 */
const AGREEMENT_STOP_THRESHOLD = 0.6;

export class Orchestrator {
  constructor(
    private adapter: InvocationAdapter,
    private renderer: Renderer,
    private availableModels: ModelConfig[],
    private defaultChairman?: string,
    private maxAgents: number = 5,
    /** Optional explicit model for role-panel design (config: role_generator_model). */
    private roleGenModel?: ModelConfig,
  ) {}

  async run(question: string, options: RunOptions): Promise<Session> {
    // Apply per-run model filter without mutating the instance list so that
    // successive calls on the same Orchestrator instance remain independent.
    const savedModels = this.availableModels;
    if (options.models && options.models.length > 0) {
      const allowed = new Set(options.models);
      this.availableModels = this.availableModels.filter(m => allowed.has(m.name));
    }
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

    // Restore the original model list so successive calls remain independent.
    this.availableModels = savedModels;

    return session;
  }

  /** Multi-round debate: broadcast → review → consensus → [cross-examine loop] → synthesis */
  private async runDebateLoop(session: Session): Promise<void> {
    // Round 0: Initial broadcast. runPhases returns true when a fatal failure
    // aborted the sequence (session.status left as 'failed').
    if (await this.runPhases(['route', 'broadcast', 'review', 'consensus'], session)) return;

    // Iterative rounds: cross-examine if consensus is low
    let round = 0;
    let fatal = false;
    while (round < MAX_DEBATE_ROUNDS - 1) {
      const consensus = session.consensus;
      if (!consensus || consensus.agreement_score >= AGREEMENT_STOP_THRESHOLD) break;

      round++;
      this.renderer.onDegradation({
        phase: 'consensus',
        reason: `Agreement low (${consensus.agreement_score.toFixed(2)})`,
        impact: `Round ${round + 1}: initiating cross-examination`,
      });

      // Cross-examine: agents see each other's responses and divergence points, then revise.
      // Guard via isFailed so a future fatal cross-examine failure aborts the loop.
      await this.executeCrossExamine(session, round);
      if (this.isFailed(session)) { fatal = true; break; }

      // Re-review the new responses
      session.status = 'reviewing';
      this.renderer.onPhaseStart('review', 0, 3);
      try {
        await this.executeReview(session);
      } catch (err) {
        if (this.handlePhaseError('review', session, err)) { fatal = true; break; }
      }

      // Re-calculate consensus
      this.renderer.onPhaseStart('consensus', 1, 3);
      try {
        this.executeConsensus(session);
      } catch (err) {
        if (this.handlePhaseError('consensus', session, err)) { fatal = true; break; }
      }
    }

    if (fatal || this.isFailed(session)) return;

    // Pre-Synthesis Compression (if needed)
    this.executePreSynthesisCompression(session);

    // Final: synthesis
    session.status = 'synthesizing';
    this.renderer.onPhaseStart('synthesis', 0, 1);
    try {
      await this.executeSynthesis(session);
    } catch (err) {
      this.handlePhaseError('synthesis', session, err);
    }
  }

  /** Runs a phase sequence. Returns true if a fatal failure aborted the run. */
  private async runPhases(phases: DebatePhase[], session: Session): Promise<boolean> {
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!;
      session.status = this.phaseToStatus(phase);
      this.renderer.onPhaseStart(phase, i, phases.length);
      try {
        await this.executePhase(phase, session);
      } catch (err) {
        if (this.handlePhaseError(phase, session, err)) return true;
      }
    }
    return false;
  }

  private createSession(question: string, options: RunOptions): Session {
    const resolvedMode = options.mode === 'auto'
      ? this.resolveAutoMode(question)
      : options.mode;

    return {
      session_id: generateId(),
      question,
      question_hash: hashQuestion(question),
      mode: options.mode,
      resolved_mode: resolvedMode,
      status: 'routing',
      agents: [],
      stages: [],
      tags: options.tags,
      parent_session_id: options.parentSessionId,
      created_at: new Date().toISOString(),
      devil_advocate_mode: options.devilAdvocate ?? false,
      historical_context: options.historicalContext,
      parent_synthesis: options.parentSynthesis,
    };
  }

  private resolveAutoMode(question: string): Exclude<DebateMode, 'auto'> {
    // Delegate to the router module which has keyword classification,
    // question type detection, and configurable heuristics.
    const decision = resolveMode(question, this.availableModels);
    return decision.mode;
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
    // Chairman: honor an explicit config default when it resolves; otherwise
    // pick the strongest model by capability tier (ties → higher config
    // priority / earlier in the list).
    const chairmanModel = this.defaultChairman
      ? models.find(m => m.name === this.defaultChairman) ?? this.selectStrongestModel(models)
      : this.selectStrongestModel(models);

    // Compute an agent-count interval per mode; the LLM picks the size that
    // fits the question's complexity (no longer driven solely by model count).
    const maxAgents = this.maxAgents;
    const upperBound = Math.min(models.length, maxAgents);
    let range: { min: number; max: number };
    if (session.resolved_mode === 'quick') {
      range = { min: 1, max: 1 };
    } else if (session.resolved_mode === 'compare') {
      range = { min: 2, max: Math.max(upperBound, 2) };
    } else {
      range = { min: 3, max: Math.max(upperBound, 3) };
    }

    // Quick mode is a single-agent path: no productive-disagreement panel to
    // design, so skip the role-generation LLM call entirely and use the
    // built-in default role (keeps the GeneratedRole[] shape consistent).
    const roles = session.resolved_mode === 'quick'
      ? defaultRoles(range.min, models)
      : await generateRoles(
          session.question,
          range,
          this.adapter,
          models,
          this.roleGenModel,
        );

    session.agents = roles.map(role => {
      const model = resolveModel(role, models);
      return {
        agent_id: generateId(),
        config: model,
        role: `${role.icon} ${role.name}`,
        role_description: role.description,
        system_prompt: role.system_prompt,
        is_chairman: model.name === chairmanModel?.name,
        is_devil_advocate: false,
      };
    });

    // Assign devil's advocate to one non-chairman agent when enabled in debate mode
    if (session.devil_advocate_mode && session.resolved_mode === 'debate') {
      const nonChairmen = session.agents.filter(a => !a.is_chairman);
      if (nonChairmen.length > 0) {
        const target = nonChairmen[Math.floor(Math.random() * nonChairmen.length)]!;
        target.is_devil_advocate = true;
      }
    }

    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private async executeBroadcast(session: Session): Promise<void> {
    const stage = this.createStage('broadcast');
    const agents = session.agents;
    const language = detectLanguage(session.question);

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
            session.historical_context,
            language,
          );

          this.renderer.onAgentStart(agent);
          try {
            const onChunk = (chunk: string) => this.renderer.onAgentProgress(agent, chunk);
            const result = await this.adapter.invoke(agent.config, prompt, onChunk);
            this.renderer.onAgentComplete(agent, result);
            this.notifyIfTruncated('broadcast', agent, result);
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

    // Aggregate peer critique (keyed by reviewed agent_id) so each agent sees
    // what reviewers said about their own answer, and a one-line signal for others.
    const reviewSummaries = this.buildReviewSummaryMap(session);
    const language = detectLanguage(session.question);

    // Extract divergence points — primarily from aggregated peer weaknesses,
    // with dimension σ as a supplement.
    const divergencePoints = session.consensus
      ? extractDivergencePoints(
          session.consensus,
          validInvocations.map(inv => ({ role: inv.role, response: inv.response_raw })),
          [...reviewSummaries.values()],
        )
      : [];

    // Each agent revises their response based on others' perspectives
    const allInvocations = await Promise.all(
      session.agents.map(async (agent) => {
        const ownInv = validInvocations.find(inv => inv.agent_id === agent.agent_id);
        if (!ownInv) return null;

        const otherResponses = validInvocations
          .filter(inv => inv.agent_id !== agent.agent_id)
          .map(inv => ({
            role: inv.role,
            response: inv.response_raw,
            reviewSummary: reviewSummaries.get(inv.agent_id),
          }));

        const prompt = buildCrossExaminePrompt(
          session.question,
          agent.role,
          ownInv.response_raw,
          otherResponses,
          divergencePoints,
          roundNumber,
          reviewSummaries.get(agent.agent_id),
          language,
        );

        this.renderer.onAgentStart(agent);
        try {
          const onChunk = (chunk: string) => this.renderer.onAgentProgress(agent, chunk);
          const result = await this.adapter.invoke(agent.config, prompt, onChunk);
          this.renderer.onAgentComplete(agent, result);
          this.notifyIfTruncated('cross_examine', agent, result);
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

    // Peer-review summaries let the Chairman weigh answers by their reception.
    const reviewSummaries = this.buildReviewSummaryMap(session);

    const responses = latestStage.invocations
      .filter(inv => !inv.timed_out && inv.response_raw)
      .map(inv => ({
        role: inv.role,
        modelName: inv.model_name,
        response: inv.response_compressed ?? inv.response_raw,
        reviewSummary: reviewSummaries.get(inv.agent_id),
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

    const prompt = buildSynthesisPrompt(session.question, responses, detectLanguage(session.question));

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
    const language = detectLanguage(session.question);

    // Get the LATEST response stage (broadcast or cross_examine for multi-round debates)
    const responseStages = session.stages.filter(
      s => (s.phase === 'broadcast' || s.phase === 'cross_examine') && s.status === 'completed',
    );
    const latestResponseStage = responseStages[responseStages.length - 1];
    if (!latestResponseStage) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    const validInvocations = latestResponseStage.invocations.filter(i => !i.timed_out && i.response_raw);
    if (validInvocations.length < 2) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    // Self-review exclusion (work item #3): with N ≥ 3 valid answers, each
    // reviewer evaluates an anonymized subset that omits its own answer. With
    // N = 2 that would leave only 1 answer per reviewer (σ / rank undefined), so
    // we fall back to the full-set path (keeps self-review) — see design note.
    const excludeSelf = validInvocations.length >= 3;

    // Full-set anonymization: used by the N = 2 path, and as a fallback subset
    // for any reviewer that produced no valid answer of its own.
    const fullAnonymizer = new Anonymizer();
    const fullAnonymized = fullAnonymizer.anonymize(
      validInvocations.map((inv, i) => ({ agentIndex: i, content: inv.response_raw })),
    );

    if (!excludeSelf) {
      // P0-2 fix: persist the shuffle-aware label→agent_id mapping on the stage.
      // anonymizer.deanonymize() uses original_agent_index (set during shuffle) to
      // correctly resolve which label maps to which agent — regardless of shuffle order.
      stage.label_map = Object.fromEntries(fullAnonymizer.deanonymize(fullAnonymized, validInvocations));
    }

    // Under self-exclusion, each reviewer gets its own label→reviewed-agent map.
    const reviewerLabelMaps: Record<string, Record<string, string>> = {};

    /**
     * Build the anonymized answer set a given reviewer should see. Under
     * self-exclusion the reviewer's own answer is removed and a fresh
     * Anonymizer shuffles/labels the remaining (N-1) answers, recording the
     * per-reviewer label map. Reviewers without an own answer, or the N = 2
     * path, receive the shared full set.
     */
    const anonymizedFor = (agent: Agent): AnonymizedResponse[] => {
      if (!excludeSelf) return fullAnonymized;
      const subset = validInvocations.filter(inv => inv.agent_id !== agent.agent_id);
      if (subset.length === validInvocations.length) {
        // Reviewer has no own answer to drop (its broadcast failed). It reviews
        // the full set; record the full-set map under its id so downstream
        // resolution still goes through the per-reviewer path (no shared
        // label_map exists under exclusion).
        reviewerLabelMaps[agent.agent_id] = Object.fromEntries(
          fullAnonymizer.deanonymize(fullAnonymized, validInvocations),
        );
        return fullAnonymized;
      }
      const anonymizer = new Anonymizer();
      const anon = anonymizer.anonymize(
        subset.map((inv, i) => ({ agentIndex: i, content: inv.response_raw })),
      );
      reviewerLabelMaps[agent.agent_id] = Object.fromEntries(anonymizer.deanonymize(anon, subset));
      return anon;
    };

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

    // P0-3 fix: parallel review — same model → serial, different models → parallel
    // (mirrors executeBroadcast pattern)
    const groups = this.groupByModel(session.agents);
    const groupResults = await Promise.all(
      groups.map(async (group) => {
        const results: Invocation[] = [];
        for (const agent of group) {
          const anonymized = anonymizedFor(agent);
          // P0-1 fix: devil's advocate gets an augmented prompt that requires
          // critical auditing (risk hunting, edge cases, assumption challenging)
          const prompt = agent.is_devil_advocate
            ? buildDevilAdvocateReviewPrompt(session.question, anonymized, language)
            : buildReviewPrompt(session.question, anonymized, language);

          this.renderer.onAgentProgress(reviewAgent, `\n--- ${agent.role} [${agent.config.name}] reviewing... ---\n`);
          try {
            const result = await this.adapter.invoke(agent.config, prompt, (chunk) => {
              this.renderer.onAgentProgress(reviewAgent, chunk);
            });
            this.renderer.onAgentProgress(reviewAgent, `\n✓ ${agent.role} review complete\n`);
            results.push(this.toInvocation(agent, result, prompt));
          } catch (err) {
            this.renderer.onAgentProgress(reviewAgent, `\n✗ ${agent.role} review failed\n`);
            this.renderer.onDegradation({
              phase: 'review',
              reason: err instanceof Error ? err.message : String(err),
              impact: `Review by ${agent.config.name} failed`,
            });
          }
        }
        return results;
      }),
    );

    const allInvocations = groupResults.flat();

    this.renderer.onAgentComplete(reviewAgent, {
      response: `${allInvocations.length} reviews completed`,
      elapsed_ms: Date.now() - new Date(stage.started_at!).getTime(),
      invocation_mode: 'api',
      timed_out: false,
    });

    if (Object.keys(reviewerLabelMaps).length > 0) {
      stage.reviewer_label_maps = reviewerLabelMaps;
    }

    stage.invocations = allInvocations;
    stage.status = allInvocations.length > 0 ? 'completed' : 'failed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  private executeConsensus(session: Session): void {
    const stage = this.createStage('consensus');

    // Find the LATEST review stage (not the first — important for multi-round debates)
    const reviewStages = session.stages.filter(s => s.phase === 'review' && s.status === 'completed');
    const reviewStage = reviewStages[reviewStages.length - 1];
    if (!reviewStage) {
      stage.status = 'skipped';
      session.stages.push(stage);
      return;
    }

    // Find the LATEST response stage (broadcast or cross_examine)
    const responseStages = session.stages.filter(
      s => (s.phase === 'broadcast' || s.phase === 'cross_examine') && s.status === 'completed',
    );
    const latestResponseStage = responseStages[responseStages.length - 1];
    const expectedLabels = (latestResponseStage?.invocations ?? [])
      .filter(i => !i.timed_out && i.response_raw)
      .map((_, i) => String.fromCharCode(65 + i));

    // Parse each review response, tagging with the reviewer's agent_id and the
    // resolved reviewed_agent_id (falls back to label inside consensus when absent).
    const allReviews = this.parseReviewStage(reviewStage, expectedLabels);

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

    // Extract review scores if available (use LATEST review stage for multi-round debates)
    const reviewScores = new Map<string, number>();
    const allReviewStages = session.stages.filter(s => s.phase === 'review' && s.status === 'completed');
    const reviewStage = allReviewStages[allReviewStages.length - 1];

    if (reviewStage && latestStage) {
      const broadcastInvocations = latestStage.invocations.filter(i => !i.timed_out && i.response_raw);
      const expectedLabels = broadcastInvocations.map((_, i) => String.fromCharCode(65 + i));

      // P0-2 fix: use the shuffle-aware label_map stored by executeReview() instead of
      // recomputing from sequential position (which ignores anonymizer shuffle order).
      const labelToAgentId = new Map<string, string>();
      if (reviewStage.label_map) {
        for (const [label, agentId] of Object.entries(reviewStage.label_map)) {
          labelToAgentId.set(label, agentId);
        }
      } else {
        // Fallback for stages that pre-date this fix
        broadcastInvocations.forEach((inv, i) => {
          labelToAgentId.set(String.fromCharCode(65 + i), inv.agent_id);
        });
      }

      // Backfill the resolved reviewed agent id (global baseline); the
      // labelToAgentId map remains as a fallback for legacy paths.
      const allReviews = this.parseReviewStage(reviewStage, expectedLabels, labelToAgentId);

      const aggregatedScores = aggregateReviewScores(allReviews, labelToAgentId);
      for (const [agentId, score] of aggregatedScores.entries()) {
        reviewScores.set(agentId, score);
      }
    }

    // Build scored responses for compression ranking
    const scored: ScoredResponse[] = validInvocations.map(inv => {
      const agent = session.agents.find(a => a.agent_id === inv.agent_id);
      return {
        agentId: inv.agent_id,
        modelName: inv.model_name,
        role: inv.role,
        content: inv.response_raw,
        reviewScore: reviewScores.get(inv.agent_id),
        modelPriority: agent?.config.priority ?? 100,
      };
    });

    const plan = buildCompressionPlan(scored, 0.6, 100_000, 2);
    if (!plan.triggered) return;

    const result = applyFallbackCompression(plan);

    // Store compressed content separately (preserving original response_raw for audit)
    for (const compressed of result.responses) {
      if (!compressed.wasCompressed) continue;
      const inv = latestStage.invocations.find(i => i.agent_id === compressed.agentId);
      if (inv) {
        inv.response_compressed = compressed.content;
      }
    }

    const stage = this.createStage('pre_synthesis_compression');
    stage.status = 'completed';
    stage.completed_at = new Date().toISOString();
    session.stages.push(stage);
  }

  /**
   * Parse a completed review stage into ParsedReview[] with reviewer and
   * reviewed agent ids resolved. Shared parse chain for consensus, compression,
   * and review-summary construction (avoids duplicating the label→agentId logic).
   *
   * Under self-review exclusion the stage carries per-reviewer label maps: each
   * review invocation is parsed against that reviewer's own (N-1) label set and
   * resolved via its own map. Otherwise the shared full-set path is used.
   *
   * @param expectedLabels Full-set label set (ignored for per-reviewer path,
   *                        which derives labels from each reviewer's own map).
   * @param labelToAgentId  Optional explicit full-set label map; when omitted the
   *                        stage's own shuffle-aware `label_map` is used.
   */
  private parseReviewStage(
    reviewStage: Stage,
    expectedLabels: string[],
    labelToAgentId?: ReadonlyMap<string, string>,
  ): ParsedReview[] {
    const perReviewer = reviewStage.reviewer_label_maps;

    return reviewStage.invocations
      .filter(inv => inv.response_raw)
      .flatMap(inv => {
        const reviewerMap = perReviewer?.[inv.agent_id];
        if (reviewerMap) {
          // Per-reviewer path: labels and reviewed-id mapping are local to this reviewer.
          const labels = Object.keys(reviewerMap);
          const result = parseReviewResponse(inv.response_raw, labels);
          return result.reviews.map(r => ({
            ...r,
            reviewer_agent_id: inv.agent_id,
            reviewed_agent_id: reviewerMap[r.label],
          }));
        }
        // Full-set path (N = 2, legacy stages, or reviewers with no own answer).
        const resolve = (label: string): string | undefined =>
          labelToAgentId ? labelToAgentId.get(label) : reviewStage.label_map?.[label];
        const result = parseReviewResponse(inv.response_raw, expectedLabels);
        return result.reviews.map(r => ({
          ...r,
          reviewer_agent_id: inv.agent_id,
          reviewed_agent_id: resolve(r.label),
        }));
      });
  }

  /**
   * Build per-answer peer-review summaries (keyed by reviewed agent_id) from the
   * latest completed review stage. Returns an empty map when no review data
   * exists yet (e.g. review was skipped / degraded to compare).
   */
  private buildReviewSummaryMap(session: Session): Map<string, AnswerReviewSummary> {
    const reviewStages = session.stages.filter(s => s.phase === 'review' && s.status === 'completed');
    const reviewStage = reviewStages[reviewStages.length - 1];
    if (!reviewStage) return new Map();

    const responseStages = session.stages.filter(
      s => (s.phase === 'broadcast' || s.phase === 'cross_examine') && s.status === 'completed',
    );
    const latestResponseStage = responseStages[responseStages.length - 1];
    const expectedLabels = (latestResponseStage?.invocations ?? [])
      .filter(i => !i.timed_out && i.response_raw)
      .map((_, i) => String.fromCharCode(65 + i));

    const reviews = this.parseReviewStage(reviewStage, expectedLabels);

    const agentIdToRole = new Map<string, string>();
    for (const agent of session.agents) {
      agentIdToRole.set(agent.agent_id, agent.role);
    }

    return buildReviewSummaries(reviews, agentIdToRole);
  }

  /** True when the session has been fatally marked as failed. */
  private isFailed(session: Session): boolean {
    return session.status === 'failed';
  }

  /**
   * Handle a phase execution error. Returns true when the failure is fatal
   * (session marked 'failed' and the debate must abort), false when the phase
   * degraded or was skipped and the run can continue.
   */
  private handlePhaseError(phase: DebatePhase, session: Session, err: unknown): boolean {
    const reason = err instanceof Error ? err.message : String(err);
    const event: DegradationEvent = {
      phase,
      reason,
      impact: '',
    };

    let fatal = false;

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
          fatal = true;
        }
        break;
      }
      case 'synthesis': {
        event.impact = 'Synthesis failed, outputting best individual response';
        const best = this.pickBestFallbackResponse(session);
        if (best) {
          session.synthesis = best;
        }
        break;
      }
      default:
        event.impact = `Phase ${phase} failed, skipping`;
    }

    session.degradation_events = session.degradation_events ?? [];
    session.degradation_events.push(event);
    this.renderer.onDegradation(event);
    return fatal;
  }

  /**
   * Select the strongest available model by capability tier (see
   * rateModelCapability). On a tie, prefer the higher config priority (lower
   * `priority` number), then the earlier position in the list.
   */
  private selectStrongestModel(models: ModelConfig[]): ModelConfig | undefined {
    if (models.length === 0) return undefined;
    return models.reduce((best, m) => {
      const bestTier = rateModelCapability(best);
      const mTier = rateModelCapability(m);
      if (mTier > bestTier) return m;
      if (mTier === bestTier && m.priority < best.priority) return m;
      return best;
    });
  }

  /**
   * Pick the best fallback response when synthesis fails. Prefers the answer
   * with the highest aggregate peer-review score from the latest review stage;
   * falls back to the fastest successful response when no review data exists.
   */
  private pickBestFallbackResponse(session: Session): string | undefined {
    const responseStages = session.stages.filter(
      s => (s.phase === 'broadcast' || s.phase === 'cross_examine') && s.status === 'completed',
    );
    const latestStage = responseStages[responseStages.length - 1];
    const valid = (latestStage?.invocations ?? []).filter(i => !i.timed_out && i.response_raw);
    if (valid.length === 0) return undefined;

    // Prefer the highest aggregate review score from the latest review stage.
    const reviewStages = session.stages.filter(s => s.phase === 'review' && s.status === 'completed');
    const reviewStage = reviewStages[reviewStages.length - 1];
    if (reviewStage) {
      const expectedLabels = valid.map((_, i) => String.fromCharCode(65 + i));
      const reviews = this.parseReviewStage(reviewStage, expectedLabels);
      const scores = aggregateReviewScores(reviews);
      if (scores.size > 0) {
        let bestInv: Invocation | undefined;
        let bestScore = -Infinity;
        for (const inv of valid) {
          const score = scores.get(inv.agent_id);
          if (score !== undefined && score > bestScore) {
            bestScore = score;
            bestInv = inv;
          }
        }
        if (bestInv) return bestInv.response_raw;
      }
    }

    // Fallback: fastest successful response (original heuristic).
    const fastest = [...valid].sort((a, b) => a.result.elapsed_ms - b.result.elapsed_ms)[0];
    return fastest?.response_raw;
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

  /**
   * Surface a truncated (max_tokens-clipped) response as a degradation event for visibility.
   * Per design (work item #4): a truncated answer still holds substantial valid content, so it
   * is NOT blocked, dropped, or retried — it flows into review/consensus/synthesis as usual;
   * we only notify the renderer so the user knows the answer may be incomplete.
   */
  private notifyIfTruncated(phase: DebatePhase, agent: Agent, result: InvocationResult): void {
    if (!result.truncated) return;
    this.renderer.onDegradation({
      phase,
      reason: `Agent "${agent.role}" response was truncated at the model's max_tokens limit`,
      impact: 'Response kept as-is and still participates in the debate; it may be incomplete',
    });
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
