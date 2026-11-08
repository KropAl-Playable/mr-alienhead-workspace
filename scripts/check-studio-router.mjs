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
  console.error('Router could not produce final schema-valid JSON. Check diagnostics above:');
  console.error('- finish=length + thinkingChars>0: generation budget was consumed by reasoning.');
  console.error('- For persistent Qwen3.5 issues, try: ollama pull qwen3:4b-instruct-2507-q4_K_M');
  console.error('- Then set MRMAK_STUDIO_ROUTER_MODEL=qwen3:4b-instruct-2507-q4_K_M and retry.');
  console.error('No routing decision was accepted from free-form or thinking text.');
  process.exitCode = 1;
}
