/**
 * Three-layer anonymization for peer review.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

export interface AgentResponse {
  agentIndex: number;
  content: string;
}

export interface AnonymizedResponse {
  label: string;
  content: string;
  original_agent_index: number;
}

export class Anonymizer {
  anonymize(responses: AgentResponse[]): AnonymizedResponse[] {
    // Layer 2: Random shuffle (eliminate position bias)
    const shuffled = this.shuffle([...responses]);

    return shuffled.map((r, i) => ({
      label: String.fromCharCode(65 + i),  // A, B, C, ...
      content: this.pipeline(r.content),
      original_agent_index: r.agentIndex,
    }));
  }

  deanonymize(
    anonymized: AnonymizedResponse[],
    originalAgents: { agent_id: string }[],
  ): Map<string, string> {
    const mapping = new Map<string, string>();
    for (const a of anonymized) {
      const agent = originalAgents[a.original_agent_index];
      if (agent) {
        mapping.set(a.label, agent.agent_id);
      }
    }
    return mapping;
  }

  private pipeline(text: string): string {
    let result = text;
    result = this.removeIdentity(result);       // Layer 1: Identity markers
    result = this.normalizeFormatting(result);   // Layer 3: Format normalization
    return result;
  }

  /** Layer 1: Remove model self-identification */
  private removeIdentity(text: string): string {
    const patterns = [
      /I'm Claude\b/gi,
      /As Claude,?\s*/gi,
      /I'm Gemini\b/gi,
      /As Gemini,?\s*/gi,
      /I'm ChatGPT\b/gi,
      /As ChatGPT,?\s*/gi,
      /I'm GPT-4\b/gi,
      /As an AI assistant created by \w+/gi,
      /I'm an AI (assistant|model) (made|created|developed) by \w+/gi,
      /As an AI (language )?model,?\s*/gi,
    ];
    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result;
  }

  /** Layer 3: Format normalization (eliminate stylistic fingerprints) */
  private normalizeFormatting(text: string): string {
    return text
      .replace(/[\u{1F600}-\u{1F9FF}]/gu, '')           // Remove emoji
      .replace(/^#{1,2}\s/gm, '### ')                    // Normalize heading levels
      .replace(/^\*/gm, '-')                              // Normalize list markers
      .replace(/\*\*(.+?)\*\*/g, '**$1**');               // Keep bold (already unified)
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
}
