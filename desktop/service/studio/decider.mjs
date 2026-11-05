// pplx-decider-flash is a decision model, NOT a text/chat generator.
// Ollama serves its typed decisions at /v1/systemone (not /api/chat).
const ROLES = ['codex', 'claude', 'qa'];
export function deterministicRoute(text) {
  const lower = String(text || '').toLowerCase();
  const art = ['art', 'visual', 'shader', 'lighting', 'animation', 'ui', 'character', 'texture', 'blender'].filter(x => lower.includes(x)).length;
  const tech = ['gameplay', 'architecture', 'algorithm', 'save', 'steam', 'bug', 'godot logic'].filter(x => lower.includes(x)).length;
  return art > tech ? 'claude' : 'codex';
}
export function parseDecision(value) {
  const answer = value?.answers?.worker;
  const chosen = typeof answer === 'string' ? answer : answer?.choice;
  return ROLES.includes(chosen) ? chosen : null;
}
export class LocalDecider {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'pplx-decider-flash', timeoutMs = 12000, fetcher = fetch } = {}) {
    const url = new URL(endpoint);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Decider must use local Ollama on loopback.');
    this.endpoint = url.origin; this.model = model; this.timeoutMs = timeoutMs; this.fetcher = fetcher;
  }
  async route(step) {
    const fallback = deterministicRoute(step.title + ' ' + step.prompt);
    try {
      const request = {
        model: this.model,
        state: { title: step.title, goal: String(step.prompt).slice(0, 6000), codex_proposed_role: step.role },
        questions: {
          worker: {
            type: 'choice',
            instructions: 'Which specialist should perform this bounded game-development subtask?',
            options: {
              codex: 'Technical director: Godot gameplay code, mechanics, data, architecture, tooling and integration.',
              claude: 'Art director: visuals, animation, UX, lighting, asset creation, key art and narrative presentation.',
              qa: 'Automated noncreative validation, reproducible tests and bug classification.'
            }
          }
        }
      };
      const response = await this.fetcher(this.endpoint + '/v1/systemone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs), body: JSON.stringify(request)
      });
      if (!response.ok) throw new Error('Ollama decision endpoint returned ' + response.status);
      const raw = await response.json();
      const role = parseDecision(raw);
      if (!role) throw new Error('Unrecognized decision response');
      return { role, source: 'pplx-decider-flash', fallback, confidence: raw.answers?.worker?.confidence ?? null };
    } catch (error) {
      return { role: step.role === 'claude' || step.role === 'codex' ? step.role : fallback, source: 'codex-plan-fallback', warning: String(error.message || error).slice(0, 200) };
    }
  }
}
