/**
 * Dynamic role generation + model assignment in one step.
 * AI sees both the question AND the available models, then designs
 * the optimal expert panel with role-model pairings.
 */

import type { InvocationAdapter } from '../types/provider.js';
import type { ModelConfig } from '../types/config.js';

export interface GeneratedRole {
  name: string;
  icon: string;
  description: string;
  system_prompt: string;
  /** Which model (by name) should play this role */
  assigned_model: string;
}

function buildModelDescription(m: ModelConfig): string {
  const traits: string[] = [];
  const id = m.model ?? m.name;

  // Provider
  traits.push(`provider: ${m.provider}`);

  // Invocation
  traits.push(m.invocation === 'cli' ? 'CLI mode' : 'API mode');

  // Infer capabilities from model name
  if (/opus|pro|5\.[3-9]|o[34]/i.test(id)) traits.push('strong reasoning');
  if (/sonnet|flash|gpt-[45]/i.test(id)) traits.push('balanced');
  if (/haiku|mini|lite|spark/i.test(id)) traits.push('fast, concise');
  if (/codex/i.test(id)) traits.push('code-specialized');
  if (/gemini/i.test(id)) traits.push('multimodal, broad knowledge');
  if (/claude/i.test(id)) traits.push('careful analysis, nuanced');
  if (/gpt/i.test(id)) traits.push('creative, versatile');

  return `${m.name} (${id}) — ${traits.join(', ')}`;
}

const ROLE_GEN_PROMPT = (question: string, models: ModelConfig[], agentCount: number, language: string) => {
  const modelList = models.map((m, i) => `  ${i + 1}. ${buildModelDescription(m)}`).join('\n');

  return `You are designing a multi-expert debate panel for a specific question.

QUESTION: "${question}"

AVAILABLE MODELS:
${modelList}

TASK: Create exactly ${agentCount} expert roles for this debate, and assign each role to the most suitable model.

Rules:
- Each role must have a UNIQUE and CONTRASTING perspective — they should DISAGREE on key points
- Roles should create productive tension, not redundant agreement
- Tailor roles to the specific domain of the question (tech roles for tech questions, business roles for business questions, etc.)
- A model CAN be assigned to multiple roles if it's the best fit (e.g. a strong reasoning model for both an analyst and a critic role)
- But PREFER diversity: spread roles across different models/providers when possible
- Assign reasoning-heavy roles to stronger models, data/speed roles to faster models
- Respond in ${language}

Return a JSON array with exactly ${agentCount} objects:
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
 */
export async function generateRoles(
  question: string,
  agentCount: number,
  adapter: InvocationAdapter,
  models: ModelConfig[],
): Promise<GeneratedRole[]> {
  const genModel = pickFastestModel(models);
  if (!genModel) return defaultRoles(agentCount, models);

  const language = detectLanguage(question);
  const prompt = ROLE_GEN_PROMPT(question, models, agentCount, language);

  try {
    const result = await adapter.invoke(genModel, prompt);
    const roles = parseRoleResponse(result.response, models);
    if (roles && roles.length >= agentCount) {
      return roles.slice(0, agentCount);
    }
    if (roles && roles.length > 0) {
      const defaults = defaultRoles(agentCount, models);
      while (roles.length < agentCount) {
        roles.push(defaults[roles.length % defaults.length]!);
      }
      return roles;
    }
  } catch {
    // Fall through
  }

  return defaultRoles(agentCount, models);
}

/**
 * Resolve a GeneratedRole's assigned_model to a ModelConfig.
 */
export function resolveModel(role: GeneratedRole, models: ModelConfig[]): ModelConfig {
  // Exact match
  const exact = models.find(m => m.name === role.assigned_model);
  if (exact) return exact;

  // Fuzzy match (model ID or partial name)
  const fuzzy = models.find(m =>
    m.model === role.assigned_model ||
    m.name.includes(role.assigned_model) ||
    role.assigned_model.includes(m.name),
  );
  if (fuzzy) return fuzzy;

  // Fallback: round-robin
  return models[0]!;
}

function pickFastestModel(models: ModelConfig[]): ModelConfig | null {
  const priorities = [
    (m: ModelConfig) => m.model?.includes('haiku'),
    (m: ModelConfig) => m.model?.includes('flash'),
    (m: ModelConfig) => m.invocation === 'api',
    (_m: ModelConfig) => true,
  ];
  for (const check of priorities) {
    const found = models.find(check);
    if (found) return found;
  }
  return models[0] ?? null;
}

function detectLanguage(text: string): string {
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g);
  if (cjk && cjk.length > text.length * 0.1) return '中文';
  return 'English';
}

function parseRoleResponse(raw: string, models: ModelConfig[]): GeneratedRole[] | null {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    const roles: GeneratedRole[] = [];
    const modelNames = models.map(m => m.name);

    for (const item of parsed) {
      const r = item as Record<string, unknown>;
      if (!r['name'] || !r['system_prompt']) continue;

      let assignedModel = String(r['assigned_model'] ?? '');
      // Validate model name exists
      if (!modelNames.includes(assignedModel)) {
        // Try fuzzy match
        const fuzzy = modelNames.find(n =>
          n.includes(assignedModel) || assignedModel.includes(n),
        );
        assignedModel = fuzzy ?? modelNames[roles.length % modelNames.length]!;
      }

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

function defaultRoles(count: number, models: ModelConfig[]): GeneratedRole[] {
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
