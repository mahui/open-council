/**
 * Dynamic role generation + model assignment in one step.
 * AI sees both the question AND the available models, then designs
 * the optimal expert panel with role-model pairings.
 */

import type { InvocationAdapter } from '../types/provider.js';
import type { ModelConfig, RoleSet } from '../types/config.js';
import { detectLanguage } from './language.js';
import { isPrefixAtBoundary } from '../shared/match.js';

export interface GeneratedRole {
  name: string;
  icon: string;
  description: string;
  system_prompt: string;
  /** Which model (by name) should play this role */
  assigned_model: string;
}

/**
 * Coarse capability tier inferred from a model's id/name.
 * 3 = strong reasoning, 2 = balanced (also the default for unrecognized ids),
 * 1 = fast/lightweight. Reusable across chairman selection (strongest wins),
 * role-panel designer selection (prefer balanced), and model descriptions.
 */
export function rateModelCapability(m: ModelConfig): number {
  const id = m.model ?? m.name;
  if (/opus|pro|5\.[3-9]|o[34]/i.test(id)) return 3;
  if (/sonnet|flash|gpt-[45]/i.test(id)) return 2;
  if (/haiku|mini|lite|spark/i.test(id)) return 1;
  return 2;
}

const CAPABILITY_TRAIT: Record<number, string> = {
  3: 'strong reasoning',
  2: 'balanced',
  1: 'fast, concise',
};

function buildModelDescription(m: ModelConfig): string {
  const traits: string[] = [];
  const id = m.model ?? m.name;

  // Provider
  traits.push(`provider: ${m.provider ?? m.protocol}`);

  // Infer capability tier from model name (shared heuristic)
  traits.push(CAPABILITY_TRAIT[rateModelCapability(m)]!);

  // Infer additional capabilities from model name
  if (/codex/i.test(id)) traits.push('code-specialized');
  if (/gemini/i.test(id)) traits.push('multimodal, broad knowledge');
  if (/claude/i.test(id)) traits.push('careful analysis, nuanced');
  if (/gpt/i.test(id)) traits.push('creative, versatile');

  return `${m.name} (${id}) — ${traits.join(', ')}`;
}

export interface AgentCountRange {
  /** Minimum number of agents (inclusive). Always satisfied. */
  min: number;
  /** Maximum number of agents (inclusive). LLM picks within [min, max]. */
  max: number;
}

const ROLE_GEN_PROMPT = (question: string, models: ModelConfig[], range: AgentCountRange, language: string) => {
  const modelList = models.map((m, i) => `  ${i + 1}. ${buildModelDescription(m)}`).join('\n');
  const fixed = range.min === range.max;

  const countDirective = fixed
    ? `Create exactly ${range.min} expert role${range.min === 1 ? '' : 's'} for this debate.`
    : `Decide how many experts this question actually needs — between ${range.min} and ${range.max} (inclusive).
  - Simple, single-domain, factual questions → use ${range.min} (the minimum)
  - Multi-stakeholder, architectural, value-laden, or ambiguous questions → use ${range.max} (the maximum)
  - Most questions land in the middle — pick the smallest count that still produces *productive* disagreement
  - Do NOT pad with redundant roles to fill the maximum. Every expert must add a perspective the others can't.`;

  return `You are designing a multi-expert debate panel for a specific question.

QUESTION: "${question}"

AVAILABLE MODELS:
${modelList}

TASK: ${countDirective}
Then assign each role to the most suitable model.

Rules:
- Each role must have a UNIQUE and CONTRASTING perspective — they should DISAGREE on key points
- Roles should create productive tension, not redundant agreement
- Tailor roles to the specific domain of the question (tech roles for tech questions, business roles for business questions, etc.)
- A model CAN be assigned to multiple roles if it's the best fit (e.g. a strong reasoning model for both an analyst and a critic role)
- But PREFER diversity: spread roles across different models/providers when possible
- Assign reasoning-heavy roles to stronger models, data/speed roles to faster models
- Respond in ${language}

Return a JSON array of role objects:
[
  {
    "name": "short role name (2-4 words, in ${language})",
    "icon": "single emoji",
    "description": "one-line description (in ${language})",
    "system_prompt": "2-3 paragraph persona in ${language}: who you are, your methodology, what you prioritize, what you push back on, your output style. Be SPECIFIC about your stance — vague roles produce vague answers.",
    "assigned_model": "exact model name from the list above"
  }
]

IMPORTANT: Return ONLY the JSON array. The "assigned_model" field MUST match one of the model names exactly.`;
};

/**
 * Generate roles and assign models in one AI call.
 * @param range Acceptable count interval; the LLM picks the size that fits the question.
 *              Pass `{min:N, max:N}` for legacy fixed-count behavior.
 * @param roleGenModel Optional explicit model to design the panel. When omitted a
 *              balanced-tier model is preferred (falling back to the fastest).
 */
export async function generateRoles(
  question: string,
  range: AgentCountRange,
  adapter: InvocationAdapter,
  models: ModelConfig[],
  roleGenModel?: ModelConfig,
): Promise<GeneratedRole[]> {
  const min = Math.max(1, range.min);
  const max = Math.max(min, range.max);

  const genModel = roleGenModel ?? pickRoleGenModel(models);
  if (!genModel) return defaultRoles(min, models);

  const language = detectLanguage(question);
  const prompt = ROLE_GEN_PROMPT(question, models, { min, max }, language);

  try {
    const result = await adapter.invoke(genModel, prompt);
    const roles = parseRoleResponse(result.response, models);
    if (roles && roles.length > 0) {
      // Honor the LLM's count if it lands in [min, max]; otherwise clamp.
      if (roles.length > max) return roles.slice(0, max);
      if (roles.length < min) {
        const defaults = defaultRoles(min, models);
        while (roles.length < min) {
          roles.push(defaults[roles.length % defaults.length]!);
        }
      }
      return roles;
    }
  } catch {
    // Fall through
  }

  return defaultRoles(min, models);
}

/**
 * Match an LLM-supplied model reference to a concrete ModelConfig.
 *
 * Precedence (deliberately strict — bare bidirectional `includes` used to let
 * "gpt-5" resolve to "gpt-5-nano" and vice-versa):
 *   1. Exact name or id.
 *   2. Prefix-*boundary* match on name or id (either direction), i.e. one is a
 *      version/variant-separated prefix of the other. Never mid-token, so
 *      "gpt-5" cannot swallow "gpt-50". On multiple candidates the shortest id
 *      wins (the closest / least-specialized family member).
 *   3. No match → undefined (callers apply round-robin).
 */
function matchAssignedModel(query: string, models: ModelConfig[]): ModelConfig | undefined {
  if (!query) return undefined;

  const exact = models.find(m => m.name === query || m.model === query);
  if (exact) return exact;

  const idOf = (m: ModelConfig): string => m.model ?? m.name;
  const boundaryHit = (m: ModelConfig): boolean => {
    const id = idOf(m);
    return (
      isPrefixAtBoundary(id, query) || isPrefixAtBoundary(query, id) ||
      (m.name !== id && (isPrefixAtBoundary(m.name, query) || isPrefixAtBoundary(query, m.name)))
    );
  };

  const candidates = models.filter(boundaryHit);
  if (candidates.length > 0) {
    return [...candidates].sort((a, b) => idOf(a).length - idOf(b).length)[0]!;
  }

  return undefined;
}

/**
 * Resolve a GeneratedRole's assigned_model to a ModelConfig. Exact → prefix
 * boundary (shortest id) → round-robin fallback (first model).
 */
export function resolveModel(role: GeneratedRole, models: ModelConfig[]): ModelConfig {
  return matchAssignedModel(role.assigned_model, models) ?? models[0]!;
}

/**
 * Choose the model that designs the expert panel. Prefers a balanced-tier model
 * (capable enough to reason about the panel, cheaper/faster than top-tier),
 * breaking ties by config priority; falls back to the fastest model otherwise.
 */
function pickRoleGenModel(models: ModelConfig[]): ModelConfig | null {
  if (models.length === 0) return null;
  const balanced = models.filter(m => rateModelCapability(m) === 2);
  if (balanced.length > 0) {
    return [...balanced].sort((a, b) => a.priority - b.priority)[0]!;
  }
  return pickFastestModel(models);
}

function pickFastestModel(models: ModelConfig[]): ModelConfig | null {
  const priorities = [
    (m: ModelConfig) => m.model?.includes('haiku'),
    (m: ModelConfig) => m.model?.includes('flash'),
    (m: ModelConfig) => m.model?.includes('mini') || m.model?.includes('nano'),
    (_m: ModelConfig) => true,
  ];
  for (const check of priorities) {
    const found = models.find(check);
    if (found) return found;
  }
  return models[0] ?? null;
}

function parseRoleResponse(raw: string, models: ModelConfig[]): GeneratedRole[] | null {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    // Strip trailing commas before ] or } — LLMs frequently produce non-standard JSON
    const sanitized = jsonMatch[0].replace(/,(\s*[}\]])/g, '$1');
    const parsed = JSON.parse(sanitized) as unknown[];
    const roles: GeneratedRole[] = [];

    for (const item of parsed) {
      const r = item as Record<string, unknown>;
      if (!r['name'] || !r['system_prompt']) continue;

      // Normalize the LLM's model reference to a canonical model name via the
      // same boundary matcher resolveModel uses: exact → prefix boundary →
      // round-robin (so "gpt-5" never silently becomes "gpt-5-nano").
      const matched = matchAssignedModel(String(r['assigned_model'] ?? ''), models);
      const assignedModel = matched?.name ?? models[roles.length % models.length]!.name;

      roles.push({
        name: String(r['name']),
        icon: String(r['icon'] ?? '🤖'),
        description: String(r['description'] ?? ''),
        system_prompt: String(r['system_prompt']),
        assigned_model: assignedModel,
      });
    }
    return roles.length > 0 ? roles : null;
  } catch {
    return null;
  }
}

/**
 * Convert an explicit RoleSet template (from `council --role-set X`) into
 * GeneratedRole[] — the same shape the dynamic panel designer produces — so the
 * explicit-override path can reuse orchestrator.executeRoute's role→agent
 * mapping verbatim (no divergent construction path).
 *
 * Model assignment: each role's `assign_to` list is an ordered model preference,
 * matched against model name / id / provider (exact first, then substring). When
 * no preference matches, models are assigned round-robin by role index.
 *
 * NOTE: role_set versioning (PRD §1780 — pinning/validating RoleSet.version) is
 * intentionally out of scope for this phase (Phase discipline). RoleSet.version
 * is carried through as data but not enforced here.
 */
export function rolesFromRoleSet(roleSet: RoleSet, models: ModelConfig[]): GeneratedRole[] {
  return Object.entries(roleSet.roles).map(([roleName, def], index) => ({
    name: roleName,
    icon: '🤖',
    description: def.description,
    system_prompt: def.system_prompt,
    assigned_model: pickModelForRole(def.assign_to, models, index).name,
  }));
}

/**
 * Resolve a role's `assign_to` preference list to a concrete model. Tries exact
 * matches (name / id / provider) across the whole preference list first, then a
 * substring pass, then falls back to round-robin by role index.
 */
function pickModelForRole(
  assignTo: readonly string[],
  models: ModelConfig[],
  index: number,
): ModelConfig {
  const exact = models.find(m =>
    assignTo.some(pref => m.name === pref || m.model === pref || m.provider === pref),
  );
  if (exact) return exact;

  const fuzzy = models.find(m =>
    assignTo.some(pref =>
      m.name.includes(pref) || pref.includes(m.name) ||
      (m.model !== undefined && (m.model.includes(pref) || pref.includes(m.model))),
    ),
  );
  if (fuzzy) return fuzzy;

  return models[index % models.length]!;
}

export function defaultRoles(count: number, models: ModelConfig[]): GeneratedRole[] {
  const defaults: GeneratedRole[] = [
    { name: '分析师', icon: '🔍', description: '注重严谨性和全面性的分析师',
      system_prompt: '你是一位注重严谨性和全面性的分析师。对任何论断先追问依据，系统性考虑边界情况和风险。结论先行，用数据和案例支撑观点。',
      assigned_model: '' },
    { name: '工程师', icon: '⚙️', description: '注重实践落地的工程师',
      system_prompt: '你是一位注重实践落地的工程师。首先考虑方案能否在生产环境运行，关注实现复杂度和运维成本。给出具体实现路径，代码示例优先于文字描述。',
      assigned_model: '' },
    { name: '创新者', icon: '💡', description: '善于跳出框架思考的创新者',
      system_prompt: '你是一位善于跳出框架思考的创新者。先理解主流方案，然后追问有没有完全不同的思路。关注新技术趋势和跨领域借鉴，提供非常规视角。',
      assigned_model: '' },
    { name: '批评家', icon: '🎯', description: '专注发现漏洞的批评家',
      system_prompt: '你是一位建设性的批评家。找出论点中的薄弱环节、逻辑漏洞和未考虑的风险。不是为了否定，而是为了让结论更健壮。',
      assigned_model: '' },
    { name: '务实派', icon: '📐', description: '关注投入产出比的务实派',
      system_prompt: '你是一位务实派。关注成本、收益、有没有更简单的替代方案。用 ROI 思维评估一切。',
      assigned_model: '' },
  ];

  // Assign models round-robin
  const result = defaults.slice(0, Math.max(count, 1));
  for (let i = 0; i < result.length; i++) {
    result[i]!.assigned_model = models[i % models.length]?.name ?? '';
  }
  return result;
}
