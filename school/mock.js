// Offline stand-in for the models (LLM_MOCK=1): exercises the whole pipeline without an API key.
// Its answers are deliberately dumb; it proves plumbing, not intelligence.
export function mockChat({ role, messages }) {
  const user = messages[messages.length - 1].content;
  let text = '';
  if (role === 'spec') {
    text = `CRITERIA:
- no crash
- car ends at rest upright on its wheels
\`\`\`js
function check(trace) {
  const f = trace.final;
  return [
    { name: 'no crash', pass: !trace.crashed, detail: String(trace.crashReason) },
    { name: 'at rest upright', pass: f.wheels >= 3 && f.upY > 0.8 && f.speed < 1 && f.x !== ${'undefined'} && trace.maxSpeed > 1, detail: 'speed ' + f.speed },
  ];
}
\`\`\``;
  } else if (role === 'auditor') {
    text = JSON.stringify({ verdict: 'approve', issues: [] });
  } else if (role === 'pilot') {
    const n = (user.match(/attempt \d+:/g) || []).length;
    text = `PLAN: floor it for ${2 + n} seconds, then brake.
\`\`\`js
function control(obs, mem) {
  if (obs.t < ${2 + n}) return { throttle: 1 };
  return { brake: obs.forwardSpeed > 0.5 ? 1 : 0 };
}
\`\`\``;
  } else if (role === 'coach') {
    text = `\`\`\`json
${JSON.stringify({
  analysis: 'mock analysis',
  insights: [{ id: 'brake-reverses', text: 'brake reverses once stopped; release it below 0.5 m/s' }],
  skills: 'function stopCar(obs) { return { brake: obs.forwardSpeed > 0.5 ? 1 : 0, throttle: obs.forwardSpeed < -0.5 ? 1 : 0 }; }',
  pilotGuidance: 'Use a phase state machine in mem.',
  specGuidance: '',
  changelog: ['mock: add brake insight and stopCar skill'],
})}
\`\`\``;
  }
  return { text, usage: { prompt_tokens: Math.round(user.length / 4), completion_tokens: Math.round(text.length / 4) }, model: `mock-${role}`, ms: 5 };
}
