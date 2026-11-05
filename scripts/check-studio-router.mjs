// Optional LIVE smoke test: one local Ollama request, no paid services or project writes.
import { LocalDecider } from '../desktop/service/studio/decider.mjs';

const router = new LocalDecider();
const sample = {
  title: 'Art direction: cozy low-poly main menu',
  prompt: 'Choose a specialist for lighting, materials, composition and golden target fidelity.',
  role: 'claude',
};
const result = await router.route(sample);
console.log(JSON.stringify({ model: router.model, ...result }, null, 2));
if (result.source === 'codex-plan-fallback') {
  console.error('Local Ollama router unavailable or returned invalid JSON. Check Ollama and model installation.');
  process.exitCode = 1;
}
