// Crusoe Managed Inference client (OpenAI-compatible chat completions).
// Retries 429/5xx with exponential backoff + jitter, limits concurrency per model, and keeps a
// ledger of every call (role, model, tokens, latency) for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CRUSOE_BASE_URL || 'https://api.inference.crusoecloud.com/v1';

// read school/.env (KEY=VALUE lines) without overriding real env vars
function loadEnv() {
  const f = path.join(HERE, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
}
loadEnv();

// Role -> model. Different families on purpose: the auditor that checks the spec is a different
// model from the one that wrote it, and load is spread across per-model rate limits.
export const MODELS = {
  spec: process.env.MODEL_SPEC || 'openai/gpt-oss-120b',
  auditor: process.env.MODEL_AUDITOR || 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  pilot: process.env.MODEL_PILOT || 'deepseek-ai/Deepseek-V4-Flash',
  coach: process.env.MODEL_COACH || 'deepseek-ai/DeepSeek-V4-Pro',
};

// backup per role when the primary is rate-limited (other families, so the auditor stays independent of gpt-oss)
export const FALLBACK = {
  spec: process.env.FALLBACK_SPEC || 'zai-org/GLM-5.3-Flash',
  auditor: process.env.FALLBACK_AUDITOR || 'zai-org/GLM-5.3-Flash',
  pilot: process.env.FALLBACK_PILOT || 'deepseek-ai/DeepSeek-V4.1-Flash',
  coach: process.env.FALLBACK_COACH || 'zai-org/GLM-5.3',
};

// per-model extra body (thinking switches differ per family)
function extraFor(model, role) {
  if (/nemotron/i.test(model)) return { chat_template_kwargs: { enable_thinking: false } };
  if (/qwen/i.test(model)) return { chat_template_kwargs: { enable_thinking: false } };
  // the coach reasons (few calls, hard analysis); pilots and checkers answer directly (many calls, speed)
  if (/deepseek/i.test(model)) return { chat_template_kwargs: { thinking: role === 'coach' && process.env.COACH_THINKING !== '0' } };
  return {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slots = new Map(); // model -> { active, queue }
const MAX_PER_MODEL = Number(process.env.LLM_CONCURRENCY || 4);

async function acquire(model) {
  let s = slots.get(model);
  if (!s) slots.set(model, (s = { active: 0, queue: [] }));
  if (s.active < MAX_PER_MODEL) {
    s.active++;
    return;
  }
  await new Promise((r) => s.queue.push(r));
  s.active++;
}
function release(model) {
  const s = slots.get(model);
  s.active--;
  const next = s.queue.shift();
  if (next) next();
}

export const ledger = { calls: 0, promptTokens: 0, completionTokens: 0, byRole: {}, onCall: null };

export function hasKey() {
  return !!process.env.CRUSOE_API_KEY;
}

/**
 * chat({ role, messages, model?, maxTokens?, temperature? }) -> { text, usage, model, ms }
 */
export async function chat({ role, messages, model = MODELS[role], maxTokens = 4096, temperature = 0.6, json = false }) {
  if (process.env.LLM_MOCK === '1') {
    const { mockChat } = await import('./mock.js');
    // always yield like a real network call would, so debounced state saves (and the dashboard) keep up
    await sleep(process.env.LLM_MOCK_DELAY ? Number(process.env.LLM_MOCK_DELAY) * (0.5 + Math.random()) : 5);
    const r = mockChat({ role, messages });
    ledger.calls++;
    (ledger.byRole[role] ||= { calls: 0, prompt: 0, completion: 0, ms: 0, model: r.model }).calls++;
    return r;
  }
  if (!hasKey()) throw new Error('CRUSOE_API_KEY is not set (put it in school/.env)');
  const body = { model, messages, max_tokens: maxTokens, temperature, ...extraFor(model, role) };
  if (json) body.response_format = { type: 'json_object' };
  await acquire(model);
  const t0 = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      let res, text;
      try {
        res = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CRUSOE_API_KEY}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180000),
        });
        text = await res.text();
      } catch (err) {
        if (attempt < 5) {
          await sleep(1000 * 2 ** attempt + Math.random() * 500);
          continue;
        }
        throw err;
      }
      if (res.status === 429 || res.status >= 500) {
        // limits are per model: after a few refusals, move this call to the role's backup model
        const fb = FALLBACK[role];
        if (attempt >= 2 && fb && body.model !== fb) {
          ledger.fallbacks = (ledger.fallbacks || 0) + 1;
          if (ledger.onCall) ledger.onCall({ role, model: body.model, fallback: fb, status: res.status });
          body.model = fb;
          Object.assign(body, extraFor(fb, role));
          await sleep(500 + Math.random() * 500);
          continue;
        }
        if (attempt < 7) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep((Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt) + Math.random() * 800);
          continue;
        }
      }
      if (!res.ok) {
        // a model that rejects a template switch: retry once without the extras
        if (res.status === 400 && body.chat_template_kwargs && attempt === 0) {
          delete body.chat_template_kwargs;
          continue;
        }
        if (res.status === 400 && body.response_format && attempt <= 1) {
          delete body.response_format;
          continue;
        }
        throw new Error(`Crusoe ${res.status} for ${model}: ${text.slice(0, 400)}`);
      }
      const data = JSON.parse(text);
      const msg = data.choices?.[0]?.message || {};
      const out = msg.content || '';
      const usage = data.usage || {};
      const ms = Date.now() - t0;
      ledger.calls++;
      ledger.promptTokens += usage.prompt_tokens || 0;
      ledger.completionTokens += usage.completion_tokens || 0;
      const r = (ledger.byRole[role] ||= { calls: 0, prompt: 0, completion: 0, ms: 0, model });
      if (body.model !== model) r.fallbackCalls = (r.fallbackCalls || 0) + 1;
      r.calls++;
      r.prompt += usage.prompt_tokens || 0;
      r.completion += usage.completion_tokens || 0;
      r.ms += ms;
      if (ledger.onCall) ledger.onCall({ role, model, usage, ms });
      if (!out.trim() && attempt < 2) {
        // reasoning model spent the budget thinking: retry with more room
        body.max_tokens = Math.min(16000, body.max_tokens * 2);
        continue;
      }
      return { text: out, usage, model: body.model, ms };
    }
  } finally {
    release(model);
  }
}

export async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${process.env.CRUSOE_API_KEY}` } });
  if (!res.ok) throw new Error(`models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.data || [];
}

// pull the first fenced code block (```js / ```javascript / ```)
export function extractCode(text) {
  const m = text.match(/```(?:js|javascript|ts)?\s*\n([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
