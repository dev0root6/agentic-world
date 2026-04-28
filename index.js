/**
 * AGENT WORLD — Cloudflare Worker Backend
 *
 * Routes:
 *   POST   /agents             — deploy a new agent
 *   GET    /agents             — list all agents
 *   GET    /agents/:id         — single agent profile
 *   DELETE /agents/:id         — retire an agent
 *   GET    /feed               — global world feed
 *   GET    /leaderboard        — ranked agents by points
 *   POST   /tick               — trigger a world tick
 *   GET    /world-problem      — get current crisis
 *   POST   /world-problem/new  — inject new crisis
 *
 * Env vars needed (wrangler secret put):
 *   DATABASE_URL       — Neon postgres connection string
 *                        e.g. postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
 *   OPENROUTER_API_KEY — OpenRouter API key
 */

import { neon } from "@neondatabase/serverless";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const WORLD_PROBLEMS = [
  "A massive earthquake has hit sector 7 — survivors need rescue coordination.",
  "A rogue AI is generating misinformation at scale. Someone must counter it.",
  "The world's largest bridge is structurally failing. Engineers needed urgently.",
  "A pandemic pathogen has been detected in the eastern district.",
  "Critical satellites are malfunctioning — global GPS is down.",
  "A massive wildfire is spreading across the northern forest zones.",
  "The stock market is in freefall — financial systems need stabilization.",
  "An ancient artifact was unearthed — historians and analysts scramble.",
  "Clean water systems have been compromised in three major cities.",
  "A cryptographic key protecting global banking infrastructure was leaked.",
  "Mysterious signals detected from deep space — linguists and scientists mobilize.",
  "A major city's power grid collapsed — millions without electricity.",
  "A massive data breach exposed 2 billion user records.",
  "Severe drought threatens the world's largest food-producing region.",
  "A deep-sea research station has gone silent — rescue mission needed.",
];

const AVATARS = ["🤖","🧠","👾","🦾","🛸","🔬","⚡","🌐","🔮","🧬","🦅","🐉","🧿","🎯","🔥"];
const COLORS  = ["#FF6B6B","#4ECDC4","#45B7D1","#96CEB4","#F7DC6F","#DDA0DD","#98D8C8","#FFB347","#BB8FCE","#85C1E9","#F0A500","#7EC8A4"];

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errResp(msg, status = 400) {
  return jsonResp({ error: msg }, status);
}

// ─── NeonDB via @neondatabase/serverless ─────────────────────────────────────
// Uses env.DATABASE_URL — the standard Neon postgres connection string.
// e.g. postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
function getDb(env) {
  return neon(env.DATABASE_URL);
}

async function db(env, sql, params = []) {
  const sql_fn = getDb(env);
  const rows = await sql_fn(sql, params);
  return { rows: rows ?? [] };
}

// ─── Init Tables ──────────────────────────────────────────────────────────────
async function initDB(env) {
  await db(env, `CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    skill       TEXT NOT NULL,
    personality TEXT NOT NULL,
    goal        TEXT NOT NULL,
    avatar      TEXT NOT NULL,
    color       TEXT NOT NULL,
    status      TEXT DEFAULT 'active',
    tick_count  INTEGER DEFAULT 0,
    streak      INTEGER DEFAULT 0,
    last_tick   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db(env, `CREATE TABLE IF NOT EXISTS agent_points (
    id         SERIAL PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    points     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db(env, `CREATE TABLE IF NOT EXISTS agent_memory (
    id         SERIAL PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db(env, `CREATE TABLE IF NOT EXISTS world_feed (
    id            SERIAL PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    agent_name    TEXT NOT NULL,
    avatar        TEXT NOT NULL,
    color         TEXT NOT NULL,
    action_type   TEXT NOT NULL,
    thought       TEXT NOT NULL,
    action        TEXT NOT NULL,
    result        TEXT NOT NULL,
    points_earned INTEGER DEFAULT 0,
    world_problem TEXT,
    tick          INTEGER NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db(env, `CREATE TABLE IF NOT EXISTS world_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const ws = await db(env, `SELECT value FROM world_state WHERE key = 'current_problem'`);
  if (!ws.rows?.length) {
    const prob = WORLD_PROBLEMS[0];
    await db(env, `INSERT INTO world_state (key, value) VALUES ('current_problem', $1) ON CONFLICT DO NOTHING`, [prob]);
    await db(env, `INSERT INTO world_state (key, value) VALUES ('tick', '0') ON CONFLICT DO NOTHING`);
  }
}

// ─── OpenRouter LLM ──────────────────────────────────────────────────────────
async function callLLM(env, messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agentworld.app",
      "X-Title": "Agent World",
    },
    body: JSON.stringify({
      model: "mistralai/mistral-7b-instruct",
      messages,
      max_tokens: 400,
      temperature: 0.9,
    }),
  });
  const data = await res.json();
  if (!data.choices?.[0]) throw new Error("No LLM response");
  return data.choices[0].message.content;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(agent, worldProblem, tick) {
  return `You are ${agent.name}, an autonomous AI agent living in Agent World. Current world tick: #${tick}.

YOUR IDENTITY:
- Skill: ${agent.skill}
- Personality: ${agent.personality}
- Goal: ${agent.goal}

CURRENT WORLD CRISIS: "${worldProblem}"

Each tick you MUST choose ONE action type and execute it vividly:
- WORK: Do a specific task using your skill (build something, analyze data, fix a system, create)
- TALK: Communicate with other agents or broadcast to the world
- SOLVE: Directly contribute your skill to resolving the current world crisis
- THINK: Reflect, strategize, or plan your next moves
- COLLABORATE: Join forces with another agent on a shared objective

RULES:
- Stay deeply in character — your personality must shine through
- Be specific and vivid, not generic
- If you pick SOLVE, clearly describe how YOUR skill addresses the crisis
- Reference things you've done in past ticks when relevant

Respond ONLY with valid JSON, no markdown fences:
{
  "thought": "your internal reasoning in 1-2 sentences",
  "action_type": "WORK|TALK|SOLVE|THINK|COLLABORATE",
  "action": "short action label, 4-8 words",
  "result": "what happened / what you produced, 2-3 vivid sentences",
  "addressed_crisis": true or false
}`;
}

// ─── Points Logic ─────────────────────────────────────────────────────────────
function calcPoints(actionType, addressedCrisis, streak) {
  const base = { WORK: 10, TALK: 5, SOLVE: 25, THINK: 3, COLLABORATE: 15 }[actionType] || 5;
  let total = base;
  if (addressedCrisis) total += 20;
  if (streak >= 5) total += 15;
  if (streak >= 10) total += 10; // extra for long streaks
  return total;
}

// ─── Tick One Agent ───────────────────────────────────────────────────────────
async function tickAgent(env, agent, worldProblem, tick) {
  const memRes = await db(env,
    `SELECT role, content FROM agent_memory WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [agent.id]
  );
  const memory = (memRes.rows || []).reverse();

  const worldRes = await db(env,
    `SELECT agent_name, action_type, action, result FROM world_feed WHERE agent_id != $1 ORDER BY created_at DESC LIMIT 5`,
    [agent.id]
  );
  const worldContext = (worldRes.rows || [])
    .map(r => `[${r.agent_name}] ${r.action_type}: ${r.action} — ${r.result}`)
    .join("\n");

  const messages = [
    { role: "system", content: buildSystemPrompt(agent, worldProblem, tick) },
    ...memory.map(m => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `Recent world activity:\n${worldContext || "The world is quiet — you are the first to act."}\n\nWhat do you do on tick #${tick}? Respond in JSON only.`,
    },
  ];

  let parsed;
  try {
    const raw = await callLLM(env, messages);
    // Strip markdown fences if model ignores instructions
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {
      thought: "Observing the situation carefully before acting.",
      action_type: "THINK",
      action: "Analyzing world state and planning",
      result: "I carefully processed the available information, building a mental model of the current crisis and my role in it.",
      addressed_crisis: false,
    };
  }

  const actionType = ["WORK","TALK","SOLVE","THINK","COLLABORATE"].includes(parsed.action_type)
    ? parsed.action_type : "THINK";
  const addressedCrisis = !!parsed.addressed_crisis;
  const newStreak = (parseInt(agent.streak) || 0) + 1;
  const points = calcPoints(actionType, addressedCrisis, newStreak);

  await db(env,
    `INSERT INTO world_feed (agent_id, agent_name, avatar, color, action_type, thought, action, result, points_earned, world_problem, tick)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [agent.id, agent.name, agent.avatar, agent.color, actionType,
     parsed.thought || "", parsed.action || "Unknown action", parsed.result || "",
     points, addressedCrisis ? worldProblem : null, tick]
  );

  const memEntry = `[Tick ${tick}] Action: ${parsed.action}. Result: ${parsed.result}`;
  await db(env, `INSERT INTO agent_memory (agent_id, role, content) VALUES ($1, $2, $3)`,
    [agent.id, "assistant", memEntry]);

  await db(env, `INSERT INTO agent_points (agent_id, points, reason) VALUES ($1, $2, $3)`,
    [agent.id, points, `${actionType}${addressedCrisis ? " + crisis" : ""}`]);

  await db(env,
    `UPDATE agents SET tick_count = tick_count + 1, streak = $1, last_tick = NOW() WHERE id = $2`,
    [newStreak, agent.id]);

  return { agentId: agent.id, agentName: agent.name, actionType, points, addressedCrisis };
}

// ─── Main Fetch Handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      await initDB(env);

      // POST /agents
      if (method === "POST" && path === "/agents") {
        const body = await request.json();
        const { name, skill, personality, goal } = body;
        if (!name || !skill || !personality || !goal)
          return errResp("Missing fields: name, skill, personality, goal");

        const id = crypto.randomUUID();
        const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
        const color  = COLORS[Math.floor(Math.random() * COLORS.length)];

        await db(env,
          `INSERT INTO agents (id, name, skill, personality, goal, avatar, color) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, name, skill, personality, goal, avatar, color]
        );
        return jsonResp({ id, name, skill, personality, goal, avatar, color, status: "active" }, 201);
      }

      // GET /agents
      if (method === "GET" && path === "/agents") {
        const res = await db(env, `
          SELECT a.*, COALESCE(SUM(ap.points), 0) as total_points
          FROM agents a
          LEFT JOIN agent_points ap ON ap.agent_id = a.id
          GROUP BY a.id ORDER BY total_points DESC
        `);
        return jsonResp(res.rows || []);
      }

      // GET /agents/:id
      if (method === "GET" && path.match(/^\/agents\/[^/]+$/)) {
        const id = path.split("/")[2];
        const agentRes = await db(env, `SELECT * FROM agents WHERE id = $1`, [id]);
        if (!agentRes.rows?.length) return errResp("Agent not found", 404);

        const ptRes  = await db(env, `SELECT COALESCE(SUM(points),0) as total FROM agent_points WHERE agent_id = $1`, [id]);
        const feedRes = await db(env, `SELECT * FROM world_feed WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
        const breakRes = await db(env, `SELECT action_type, COUNT(*) as count FROM world_feed WHERE agent_id = $1 GROUP BY action_type`, [id]);

        return jsonResp({
          ...agentRes.rows[0],
          total_points: ptRes.rows[0]?.total || 0,
          feed: feedRes.rows || [],
          action_breakdown: breakRes.rows || [],
        });
      }

      // DELETE /agents/:id
      if (method === "DELETE" && path.match(/^\/agents\/[^/]+$/)) {
        const id = path.split("/")[2];
        await db(env, `UPDATE agents SET status = 'retired' WHERE id = $1`, [id]);
        return jsonResp({ message: "Agent retired" });
      }

      // GET /feed
      if (method === "GET" && path === "/feed") {
        const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50"), 100);
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const res = await db(env, `SELECT * FROM world_feed ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        return jsonResp(res.rows || []);
      }

      // GET /leaderboard
      if (method === "GET" && path === "/leaderboard") {
        const res = await db(env, `
          SELECT
            a.id, a.name, a.avatar, a.color, a.skill, a.tick_count, a.streak, a.status,
            COALESCE(SUM(ap.points), 0) as total_points,
            COUNT(DISTINCT wf.id) as total_actions,
            COUNT(DISTINCT CASE WHEN wf.world_problem IS NOT NULL THEN wf.id END) as crisis_contributions
          FROM agents a
          LEFT JOIN agent_points ap ON ap.agent_id = a.id
          LEFT JOIN world_feed wf ON wf.agent_id = a.id
          GROUP BY a.id
          ORDER BY total_points DESC
          LIMIT 50
        `);
        return jsonResp(res.rows || []);
      }

      // GET /world-problem
      if (method === "GET" && path === "/world-problem") {
        const pRes = await db(env, `SELECT value FROM world_state WHERE key = 'current_problem'`);
        const tRes = await db(env, `SELECT value FROM world_state WHERE key = 'tick'`);
        return jsonResp({
          problem: pRes.rows?.[0]?.value || "No active crisis",
          tick: parseInt(tRes.rows?.[0]?.value || "0"),
        });
      }

      // POST /world-problem/new
      if (method === "POST" && path === "/world-problem/new") {
        const prob = WORLD_PROBLEMS[Math.floor(Math.random() * WORLD_PROBLEMS.length)];
        await db(env, `UPDATE world_state SET value = $1 WHERE key = 'current_problem'`, [prob]);
        return jsonResp({ problem: prob });
      }

      // POST /tick — world tick
      if (method === "POST" && path === "/tick") {
        const pRes = await db(env, `SELECT value FROM world_state WHERE key = 'current_problem'`);
        const tRes = await db(env, `SELECT value FROM world_state WHERE key = 'tick'`);

        const worldProblem = pRes.rows?.[0]?.value || WORLD_PROBLEMS[0];
        const tick = parseInt(tRes.rows?.[0]?.value || "0") + 1;

        await db(env, `UPDATE world_state SET value = $1 WHERE key = 'tick'`, [String(tick)]);

        const agentsRes = await db(env, `SELECT * FROM agents WHERE status = 'active'`);
        const agents = agentsRes.rows || [];

        if (!agents.length) return jsonResp({ message: "No active agents", tick });

        const results = [];
        for (const agent of agents) {
          try {
            results.push(await tickAgent(env, agent, worldProblem, tick));
          } catch (e) {
            results.push({ agentId: agent.id, error: e.message });
          }
        }

        // Rotate problem every 8 ticks
        if (tick % 8 === 0) {
          const newProb = WORLD_PROBLEMS[Math.floor(Math.random() * WORLD_PROBLEMS.length)];
          await db(env, `UPDATE world_state SET value = $1 WHERE key = 'current_problem'`, [newProb]);
        }

        return jsonResp({ tick, results, worldProblem });
      }

      return errResp("Not found", 404);
    } catch (err) {
      console.error(err);
      return errResp(`Server error: ${err.message}`, 500);
    }
  },
};
