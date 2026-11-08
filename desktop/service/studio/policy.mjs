// A task-scoped, owner-reviewed authorization record.
// It does not bypass Claude/Codex provider policies or meter charges in a web tab.
const TOOL_KEYS = ['playwright', 'blender', 'tripo', 'imagegen'];
export const guardedPolicy = () => ({
  mode: 'guarded', tools: Object.fromEntries(TOOL_KEYS.map(k => [k, false])),
  tripoCreditCap: 0, tripoAttemptsPerAsset: 2, autoResume: false,
  maxRateLimitRetries: 0, retryDelayMinutes: 30,
});
export function validateStudioPolicy(input) {
  if (input == null || input.mode === 'guarded') return guardedPolicy();
  if (input.mode !== 'autonomous' || input.ownerAuthorized !== true)
    throw new Error('Autonomous Studio mode requires explicit owner authorization.');
  const values = input.tools;
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || TOOL_KEYS.some(k => typeof values[k] !== 'boolean'))
    throw new Error('Choose explicit tools for this autonomous task.');
  const credits = input.tripoCreditCap;
  if (!Number.isInteger(credits) || credits < 0 || credits > 1500 || (values.tripo && credits < 100)
    || (!values.tripo && credits !== 0))
    throw new Error('Tripo credit authorization must be 0-1500, and >=100 when Tripo is enabled.');
  const perAsset = input.tripoAttemptsPerAsset ?? 2;
  if (perAsset !== 2) throw new Error('Studio permits only two Tripo attempts per asset brief; third requires a new authorization.');
  const retries = input.maxRateLimitRetries ?? 3;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5)
    throw new Error('Rate-limit retries must be between 0 and 5.');
  const delay = input.retryDelayMinutes ?? 30;
  if (!Number.isInteger(delay) || delay < 5 || delay > 240)
    throw new Error('Retry delay must be 5-240 minutes.');
  return {
    mode: 'autonomous',
    tools: Object.fromEntries(TOOL_KEYS.map(k => [k, values[k]])),
    tripoCreditCap: credits, tripoAttemptsPerAsset: perAsset,
    autoResume: input.autoResume === true,
    maxRateLimitRetries: retries, retryDelayMinutes: delay,
  };
}
export const isAutonomous = p => p?.mode === 'autonomous';
export function policyBrief(policy) {
  if (!isAutonomous(policy)) return [
    'Use standard guarded permissions. External browser generation and paid services are NOT pre-approved.',
    'Ask for owner approval through Studio for paid actions or extended GPU testing.',
  ].join('\n');
  const yes = Object.entries(policy.tools).filter(([,v]) => v).map(([k]) => k).join(', ') || 'none';
  return [
    'TASK-SCOPED OWNER AUTHORIZATION: Studio autonomous production mode is enabled for this approved batch.',
    'Approved creative tools: ' + yes + '. All unlisted providers require separate authorization.',
    'Claude Code: use built-in AUTO permissions mode; still obey classifier denials, provider terms, login requirements and OS boundaries.',
    'Codex: operate inside workspace-write sandbox. Do not request privilege escalation.',
    'Playwright extension: use only existing authenticated sessions for approved image generation and Tripo; never bypass CAPTCHA or restrictions.',
    'Tripo spending envelope for this entire task: maximum ' + policy.tripoCreditCap + ' credits. Smart Mesh estimated at 100 credits/job.',
    'Maximum TWO attempts per individual asset brief. Before every Tripo submission, check remaining credits and previous job receipts; log job ID, asset brief and cost in an asset ledger saved to this worktree.',
    'The browser does not enforce this budget automatically. STOP external generation if remaining credit amount cannot be established, or a previous job may still be processing.',
    'Blender and image generation can be used for approved creative work. Do not publish, purchase subscriptions, replenish credits, create accounts or change golden targets.',
    'If usage limits are hit: record a checkpoint of files/job IDs; allow Studio to wait for limits, then continue without repeating completed paid jobs.',
    'Do not treat this authorization as consent to destructive actions outside the worktree or long resource-intensive QA on the owner workstation.',
  ].join('\n');
}
