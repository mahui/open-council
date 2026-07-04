/**
 * Route engine: auto mode determination + keyword strategy + Agent seat allocation.
 * Pure logic — no I/O dependencies (ARCH-01).
 * No imports from providers, storage, ui, commands (ARCH-02).
 */

import type { ModelConfig, CouncilConfig, RoleSet } from '../types/config.js';
import type { DebateMode, Agent, RunOptions } from '../types/session.js';
// Use globalThis.crypto to avoid importing node:crypto in core/ (ARCH-01)
const randomUUID = (): string => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// Question type classification
// ---------------------------------------------------------------------------

export type QuestionType =
  | 'code'
  | 'architecture'
  | 'security'
  | 'creative'
  | 'comparison'
  | 'math'
  | 'general';

interface KeywordRule {
  type: QuestionType;
  keywords: RegExp;
  requiredCapabilities: string[];
  suggestedRoleSet: string;
}

/**
 * Table-driven rule definition.
 *
 * Keywords are split into two groups because word boundaries (`\b`) only
 * recognize ASCII word characters — a Chinese character never forms a `\b`
 * boundary with its neighbour, so Chinese keywords wrapped in `\b...\b` can
 * NEVER match. English keywords keep `\b` (to avoid matching substrings such
 * as `code` inside `encoder`); Chinese keywords are matched literally.
 *
 * `en` entries may be small regex fragments (e.g. `vs\.?`, `which\s+is\s+better`).
 */
interface KeywordRuleDef {
  type: QuestionType;
  en: readonly string[];
  zh: readonly string[];
  requiredCapabilities: string[];
  suggestedRoleSet: string;
}

/**
 * Build a case-insensitive matcher combining an ASCII-boundary-guarded English
 * group with an unguarded Chinese group: `\b(?:en...)\b|(?:zh...)`.
 */
function buildKeywordPattern(en: readonly string[], zh: readonly string[]): RegExp {
  const parts: string[] = [];
  if (en.length > 0) parts.push(`\\b(?:${en.join('|')})\\b`);
  if (zh.length > 0) parts.push(`(?:${zh.join('|')})`);
  return new RegExp(parts.join('|'), 'i');
}

const KEYWORD_RULE_DEFS: readonly KeywordRuleDef[] = [
  {
    type: 'code',
    en: ['code', 'coding', 'bug', 'debug', 'function', 'refactor', 'lint', 'compile', 'snippet', 'implementation'],
    zh: ['函数', '代码', '重构', '编译', '调试', '报错', '实现'],
    requiredCapabilities: ['code'],
    suggestedRoleSet: 'code-review',
  },
  {
    type: 'security',
    en: ['security', 'vulnerability', 'CVE', 'exploit', 'injection', 'XSS', 'CSRF', 'auth', 'encrypt'],
    zh: ['注入', '安全', '认证', '鉴权', '权限', '加密', '漏洞'],
    requiredCapabilities: ['analysis'],
    suggestedRoleSet: 'default',
  },
  {
    type: 'architecture',
    en: ['architecture', 'design', 'system', 'microservice', 'monolith', 'scalab', 'distributed'],
    zh: ['架构', '设计', '系统', '可扩展', '扩展性', '分布式', '微服务', '单体'],
    requiredCapabilities: ['analysis'],
    suggestedRoleSet: 'architecture',
  },
  {
    type: 'creative',
    en: ['creative', 'brainstorm', 'ideation', 'novel', 'unconventional'],
    zh: ['创意', '头脑风暴', '创新', '灵感'],
    requiredCapabilities: ['creative'],
    suggestedRoleSet: 'default',
  },
  {
    type: 'comparison',
    en: ['vs\\.?', 'versus', 'compare', 'choose', 'which\\s+is\\s+better', 'pros?\\s+and\\s+cons?'],
    zh: ['对比', '比较', '选择', '优劣', '区别', '相比', '哪个更好'],
    requiredCapabilities: [],
    suggestedRoleSet: 'default',
  },
  {
    type: 'math',
    en: ['math', 'calcul', 'proof', 'equation', 'theorem', 'algorithm'],
    zh: ['数学', '计算', '证明', '方程', '定理', '算法', '公式', '求解'],
    requiredCapabilities: ['math'],
    suggestedRoleSet: 'default',
  },
] as const;

const KEYWORD_RULES: readonly KeywordRule[] = KEYWORD_RULE_DEFS.map(def => ({
  type: def.type,
  keywords: buildKeywordPattern(def.en, def.zh),
  requiredCapabilities: def.requiredCapabilities,
  suggestedRoleSet: def.suggestedRoleSet,
}));

// ---------------------------------------------------------------------------
// Auto mode resolution
// ---------------------------------------------------------------------------

export interface ModeDecision {
  mode: Exclude<DebateMode, 'auto'>;
  reason: string;
  questionType: QuestionType;
  estimatedCalls: number;
}

/**
 * Determine the debate mode for an `auto` request.
 *
 * Heuristic (keyword strategy, no LLM cost):
 *   1. Classify the question type via keyword matching.
 *   2. If only 1 model is available -> quick.
 *   3. If question is short (<30 chars) AND general -> compare.
 *   4. If question type is architecture/security or question is long (>120 chars) -> debate.
 *   5. If comparison keywords detected -> compare.
 *   6. Default -> compare.
 */
export function resolveMode(
  question: string,
  models: readonly ModelConfig[],
  config?: Pick<CouncilConfig, 'general' | 'routing'>,
): ModeDecision {
  const enabledModels = models.filter(m => m.enabled);
  const questionType = classifyQuestion(question, config?.general?.high_risk_keywords);

  // Single model: always quick
  if (enabledModels.length < 2) {
    return {
      mode: 'quick',
      reason: 'Only 1 available model',
      questionType,
      estimatedCalls: 1,
    };
  }

  const length = question.trim().length;

  // High-complexity types -> debate (if enough models)
  if (
    (questionType === 'architecture' || questionType === 'security') &&
    length > 50
  ) {
    const agentCount = Math.min(enabledModels.length, config?.general?.max_agents ?? 5);
    return {
      mode: 'debate',
      reason: `Detected ${questionType} keywords with substantial question`,
      questionType,
      estimatedCalls: agentCount * 3, // broadcast + review + synthesis
    };
  }

  // Comparison keywords -> compare
  if (questionType === 'comparison') {
    const agentCount = Math.min(enabledModels.length, config?.general?.max_agents ?? 5);
    return {
      mode: 'compare',
      reason: 'Comparison question detected',
      questionType,
      estimatedCalls: agentCount + 1, // broadcast + synthesis
    };
  }

  // Long complex questions -> debate
  if (length > 120 && enabledModels.length >= 3) {
    const agentCount = Math.min(enabledModels.length, config?.general?.max_agents ?? 5);
    return {
      mode: 'debate',
      reason: 'Long question with sufficient models for multi-perspective debate',
      questionType,
      estimatedCalls: agentCount * 3,
    };
  }

  // Short simple questions -> compare (still multi-model but skip review)
  if (length < 30 && questionType === 'general') {
    return {
      mode: 'compare',
      reason: 'Short general question',
      questionType,
      estimatedCalls: enabledModels.length + 1,
    };
  }

  // Default -> compare
  const agentCount = Math.min(enabledModels.length, config?.general?.max_agents ?? 5);
  return {
    mode: 'compare',
    reason: 'Default multi-model comparison',
    questionType,
    estimatedCalls: agentCount + 1,
  };
}

// ---------------------------------------------------------------------------
// Question classification
// ---------------------------------------------------------------------------

/**
 * Classify a question by keyword matching.
 * Returns the first matching type, or 'general' if none match.
 */
export function classifyQuestion(
  question: string,
  extraHighRiskKeywords?: readonly string[],
): QuestionType {
  // Check extra high-risk keywords first (treated as architecture/security)
  if (extraHighRiskKeywords && extraHighRiskKeywords.length > 0) {
    const lowerQ = question.toLowerCase();
    for (const kw of extraHighRiskKeywords) {
      if (lowerQ.includes(kw.toLowerCase())) {
        return 'architecture';
      }
    }
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.test(question)) {
      return rule.type;
    }
  }

  return 'general';
}

// ---------------------------------------------------------------------------
// Agent seat allocation
// ---------------------------------------------------------------------------

export interface SeatAllocationInput {
  models: readonly ModelConfig[];
  options: Pick<RunOptions, 'chairman' | 'devilAdvocate' | 'roleSet'>;
  questionType: QuestionType;
  resolvedMode: Exclude<DebateMode, 'auto'>;
  roleSet?: RoleSet;
  config?: Pick<CouncilConfig, 'general'>;
}

export interface SeatAllocationResult {
  agents: Agent[];
  chairmanId: string;
  roleSetUsed: string;
}

const DEFAULT_ROLES: readonly string[] = [
  'analyst',
  'engineer',
  'innovator',
  'critic',
  'pragmatist',
];

/**
 * Allocate agent seats: assign models to roles based on capabilities.
 *
 * Strategy (from PRD 2.3):
 * - >= 3 models: each model gets 1 role, prefer different models
 * - 2 models: 2 models each get 1 role + optional 3rd seat reusing higher-priority model
 * - 1 model: same model plays all roles (single-model multi-role mode)
 *
 * Respects `min_agents` / `max_agents` from config.
 */
export function allocateSeats(input: SeatAllocationInput): SeatAllocationResult {
  const {
    models,
    options,
    questionType,
    resolvedMode,
    roleSet,
    config,
  } = input;

  const enabledModels = models
    .filter(m => m.enabled)
    .sort((a, b) => a.priority - b.priority); // lower priority number = higher priority

  if (enabledModels.length === 0) {
    return { agents: [], chairmanId: '', roleSetUsed: 'default' };
  }

  const minAgents = config?.general?.min_agents ?? 2;
  const maxAgents = config?.general?.max_agents ?? 5;
  const allowSameModel = config?.general?.allow_same_model_agents ?? true;

  // Determine the role list
  const roleNames = getRoleNames(roleSet, questionType);
  const roleSetName = getSuggestedRoleSet(questionType, options.roleSet);

  // Determine how many seats to create
  let targetSeats: number;
  if (resolvedMode === 'quick') {
    targetSeats = Math.max(1, Math.min(enabledModels.length, maxAgents));
  } else {
    targetSeats = Math.max(minAgents, Math.min(roleNames.length, maxAgents));
  }

  // Allocate models to seats
  const agents: Agent[] = [];
  for (let i = 0; i < targetSeats; i++) {
    const role = roleNames[i % roleNames.length] ?? 'analyst';
    const roleDesc = getRoleDescription(roleSet, role);

    // Pick model: prefer different models for diversity, then cycle
    let model: ModelConfig;
    if (i < enabledModels.length) {
      model = enabledModels[i]!;
    } else if (allowSameModel) {
      // Reuse highest-priority model first
      model = enabledModels[i % enabledModels.length]!;
    } else {
      // Cannot reuse models — stop allocating
      break;
    }

    // Prefer models with matching capabilities
    const preferred = findPreferredModel(enabledModels, role, questionType, agents);
    if (preferred && i < enabledModels.length) {
      model = preferred;
    }

    agents.push({
      agent_id: randomUUID(),
      config: model,
      role,
      role_description: roleDesc,
      system_prompt: getRoleSystemPrompt(roleSet, role),
      is_chairman: false,
      is_devil_advocate: false,
    });
  }

  // Ensure minimum seats by reusing models
  while (agents.length < minAgents && allowSameModel && enabledModels.length > 0) {
    const idx = agents.length % enabledModels.length;
    const role = roleNames[agents.length % roleNames.length] ?? 'analyst';
    agents.push({
      agent_id: randomUUID(),
      config: enabledModels[idx]!,
      role,
      role_description: getRoleDescription(roleSet, role),
      system_prompt: getRoleSystemPrompt(roleSet, role),
      is_chairman: false,
      is_devil_advocate: false,
    });
  }

  // Assign chairman
  const chairmanName = options.chairman;
  let chairmanAgent = chairmanName
    ? agents.find(a => a.config.name === chairmanName)
    : undefined;
  if (!chairmanAgent && agents.length > 0) {
    // Fallback: highest-priority agent
    chairmanAgent = agents.reduce((best, curr) =>
      curr.config.priority < best.config.priority ? curr : best,
    );
  }
  if (chairmanAgent) {
    chairmanAgent.is_chairman = true;
  }

  // Assign devil's advocate (debate mode only)
  if (resolvedMode === 'debate') {
    assignDevilAdvocate(agents, questionType, options.devilAdvocate);
  }

  return {
    agents,
    chairmanId: chairmanAgent?.agent_id ?? '',
    roleSetUsed: roleSetName,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getRoleNames(roleSet: RoleSet | undefined, questionType: QuestionType): string[] {
  if (roleSet) {
    return Object.keys(roleSet.roles);
  }
  // Default roles — reorder based on question type
  const roles = [...DEFAULT_ROLES];
  if (questionType === 'code') {
    // Promote engineer
    const idx = roles.indexOf('engineer');
    if (idx > 0) {
      roles.splice(idx, 1);
      roles.unshift('engineer');
    }
  } else if (questionType === 'creative') {
    const idx = roles.indexOf('innovator');
    if (idx > 0) {
      roles.splice(idx, 1);
      roles.unshift('innovator');
    }
  }
  return roles;
}

function getRoleDescription(roleSet: RoleSet | undefined, role: string): string {
  if (roleSet && roleSet.roles[role]) {
    return roleSet.roles[role].description;
  }
  return '';
}

function getRoleSystemPrompt(roleSet: RoleSet | undefined, role: string): string {
  if (roleSet && roleSet.roles[role]) {
    return roleSet.roles[role].system_prompt;
  }
  return '';
}

function getSuggestedRoleSet(questionType: QuestionType, override?: string): string {
  if (override) return override;
  for (const rule of KEYWORD_RULES) {
    if (rule.type === questionType) {
      return rule.suggestedRoleSet;
    }
  }
  return 'default';
}

/**
 * Find a model that has capabilities matching the role/question type,
 * and has not already been assigned (to maximize diversity).
 */
function findPreferredModel(
  models: readonly ModelConfig[],
  _role: string,
  questionType: QuestionType,
  existingAgents: readonly Agent[],
): ModelConfig | undefined {
  const usedModelNames = new Set(existingAgents.map(a => a.config.name));

  // Find required capabilities for this question type
  const rule = KEYWORD_RULES.find(r => r.type === questionType);
  const requiredCaps = rule?.requiredCapabilities ?? [];

  if (requiredCaps.length === 0) return undefined;

  // Prefer unused models with matching capabilities
  const candidates = models.filter(
    m => !usedModelNames.has(m.name) && requiredCaps.every(c => m.capabilities.includes(c)),
  );

  if (candidates.length > 0) {
    return candidates.sort((a, b) => a.priority - b.priority)[0];
  }

  return undefined;
}

/**
 * Assign devil's advocate role in debate mode.
 *
 * Trigger conditions (any one):
 * - agents.length >= 3
 * - question type is architecture or security
 * - user explicitly requested it
 *
 * Selection: prefer model with 'analysis' capability; otherwise highest priority.
 */
function assignDevilAdvocate(
  agents: Agent[],
  questionType: QuestionType,
  userRequested?: boolean,
): void {
  const shouldAssign =
    userRequested === true ||
    agents.length >= 3 ||
    questionType === 'architecture' ||
    questionType === 'security';

  if (!shouldAssign || agents.length === 0) return;

  // Prefer non-chairman with 'analysis' capability
  const candidates = agents
    .filter(a => !a.is_chairman)
    .sort((a, b) => {
      const aHasAnalysis = a.config.capabilities.includes('analysis') ? 0 : 1;
      const bHasAnalysis = b.config.capabilities.includes('analysis') ? 0 : 1;
      if (aHasAnalysis !== bHasAnalysis) return aHasAnalysis - bHasAnalysis;
      return a.config.priority - b.config.priority;
    });

  const target = candidates[0] ?? agents.find(a => !a.is_chairman) ?? agents[0];
  if (target) {
    target.is_devil_advocate = true;
  }
}
