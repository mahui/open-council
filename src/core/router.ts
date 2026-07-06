/**
 * Route engine: auto mode determination + keyword-strategy classification.
 * Pure logic — no I/O dependencies (ARCH-01).
 * No imports from providers, storage, ui, commands (ARCH-02).
 */

import type { ModelConfig, CouncilConfig } from '../types/config.js';
import type { DebateMode } from '../types/session.js';

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
  },
  {
    type: 'security',
    en: ['security', 'vulnerability', 'CVE', 'exploit', 'injection', 'XSS', 'CSRF', 'auth', 'encrypt'],
    zh: ['注入', '安全', '认证', '鉴权', '权限', '加密', '漏洞'],
  },
  {
    type: 'architecture',
    en: ['architecture', 'design', 'system', 'microservice', 'monolith', 'scalab', 'distributed'],
    zh: ['架构', '设计', '系统', '可扩展', '扩展性', '分布式', '微服务', '单体'],
  },
  {
    type: 'creative',
    en: ['creative', 'brainstorm', 'ideation', 'novel', 'unconventional'],
    zh: ['创意', '头脑风暴', '创新', '灵感'],
  },
  {
    type: 'comparison',
    en: ['vs\\.?', 'versus', 'compare', 'choose', 'which\\s+is\\s+better', 'pros?\\s+and\\s+cons?'],
    zh: ['对比', '比较', '选择', '优劣', '区别', '相比', '哪个更好'],
  },
  {
    type: 'math',
    en: ['math', 'calcul', 'proof', 'equation', 'theorem', 'algorithm'],
    zh: ['数学', '计算', '证明', '方程', '定理', '算法', '公式', '求解'],
  },
] as const;

const KEYWORD_RULES: readonly KeywordRule[] = KEYWORD_RULE_DEFS.map(def => ({
  type: def.type,
  keywords: buildKeywordPattern(def.en, def.zh),
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
 *   3. If question is short (<30 effective length) AND general -> compare.
 *   4. If question type is architecture/security or question is long (>120
 *      effective length) -> debate.
 *   5. If comparison keywords detected -> compare.
 *   6. Default -> compare.
 *
 * Length is measured with `effectiveLength` (CJK-weighted), not raw char count,
 * so information-dense Chinese questions cross the same thresholds as their
 * more verbose English equivalents.
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

  const length = effectiveLength(question);

  // High-complexity types -> debate (if enough models). The length gate only
  // filters throwaway one-liners ("架构好吗?"); keyword classification already
  // established substance, so the bar is low — a typical 17-hanzi architecture
  // question (effective ~43) must clear it.
  if (
    (questionType === 'architecture' || questionType === 'security') &&
    length > 40
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
// Length metric
// ---------------------------------------------------------------------------

/**
 * CJK code-point ranges: unified ideographs (incl. Ext-A) + compatibility,
 * hiragana/katakana, and Hangul. Used only to weight length — approximate
 * coverage is sufficient.
 */
const CJK_PATTERN =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * Length metric that weights CJK characters more heavily than Latin ones.
 *
 * The `resolveMode` thresholds (50 / 120 / 30) were tuned against English, but
 * CJK carries ~2.5× the information per character, so a raw char count badly
 * understates a Chinese question's complexity. Each CJK character counts 2.5,
 * every other character 1; the total is floored to stay an integer.
 */
export function effectiveLength(question: string): number {
  let total = 0;
  for (const ch of question.trim()) {
    total += CJK_PATTERN.test(ch) ? 2.5 : 1;
  }
  return Math.floor(total);
}
