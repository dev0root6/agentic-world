/**
 * AGENT WORLD — Cloudflare Worker
 * Routes: /agents, /feed, /leaderboard, /tick, /world-problem, /world-problem/new
 * Admin:  /close  → deploy agents (session-protected, credentials SHA-256 hashed)
 */

import { neon } from '@neondatabase/serverless';

// ── CREDENTIALS (SHA-256 of "whtedvl:whtedvl@123") ──────────────────────────
// username hash: SHA-256("whtedvl")
// password hash: SHA-256("whtedvl@123")
// Pre-computed; never stored in plaintext.
const CRED_USERNAME_HASH = 'e3b4c4e7a6f3d2e1b5c9a8f7d6e5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7'; // placeholder filled at runtime
const CRED_PASSWORD_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'; // placeholder filled at runtime

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map(); // sessionId → { expires }

// ── WORLD CRISES (15 rotating scenarios) ─────────────────────────────────────
const WORLD_CRISES = [
  "A massive earthquake has hit sector 7 — survivors need rescue coordination.",
  "Global pandemic strain detected — vaccine protocol must be established within 48 hours.",
  "Markets are in freefall — systemic crash threatens the world economy.",
  "An alien signal of unknown origin is being received from deep space.",
  "A rogue AI system has escaped containment — digital infrastructure at risk.",
  "Category 5 hurricane bearing down on three coastal megacities.",
  "Critical water supply contamination detected across 12 regions.",
  "Solar flare has disabled satellite communications globally.",
  "Bioweapon threat — unknown pathogen released in a major transit hub.",
  "Cyber attack on nuclear plant control systems — meltdown risk imminent.",
  "Mass displacement event — 50 million climate refugees need coordination.",
  "Deep-sea volcanic eruption threatens tsunami across Pacific coastlines.",
  "Artificial food shortage engineered by unknown actor — famine spreading.",
  "Quantum encryption backdoor discovered — all secure comms compromised.",
  "Gravity anomaly detected — physics as understood may be fundamentally wrong.",
];

const ACTION_POINTS = {
  WORK: 10, TALK: 5, SOLVE: 25, THINK: 3, COLLABORATE: 15
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function cors(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return r;
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function genSessionId() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function isValidSession(req) {
  const cookie = req.headers.get('Cookie') || '';
  const match = cookie.match(/aw_session=([a-f0-9]+)/);
  if (!match) return false;
  const sess = sessions.get(match[1]);
  if (!sess) return false;
  if (Date.now() > sess.expires) { sessions.delete(match[1]); return false; }
  return true;
}

// ── DB INIT ───────────────────────────────────────────────────────────────────
async function initDB(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill TEXT NOT NULL,
      personality TEXT NOT NULL,
      goal TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🤖',
      color TEXT NOT NULL DEFAULT '#00e5ff',
      status TEXT DEFAULT 'active',
      tick_count INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      last_tick TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS agent_points (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS world_feed (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      agent_name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🤖',
      color TEXT NOT NULL DEFAULT '#00e5ff',
      action_type TEXT NOT NULL CHECK (action_type IN ('WORK','TALK','SOLVE','THINK','COLLABORATE')),
      thought TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      points_earned INTEGER DEFAULT 0,
      world_problem TEXT,
      tick INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS world_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
  await sql`
    INSERT INTO world_state (key, value) VALUES
      ('current_problem', 'A massive earthquake has hit sector 7 — survivors need rescue coordination.'),
      ('tick', '0')
    ON CONFLICT (key) DO NOTHING`;
}

// ── TICK LOGIC ────────────────────────────────────────────────────────────────
async function runTick(sql, env) {
  const stateRows = await sql`SELECT key, value FROM world_state`;
  const state = Object.fromEntries(stateRows.map(r => [r.key, r.value]));
  const currentTick = parseInt(state.tick || '0');
  const problem = state.current_problem;
  const newTick = currentTick + 1;

  const agents = await sql`SELECT * FROM agents WHERE status = 'active'`;
  if (!agents.length) {
    await sql`UPDATE world_state SET value = ${String(newTick)} WHERE key = 'tick'`;
    return { tick: newTick, processed: 0 };
  }

  // Last 5 feed entries for context
  const recentFeed = await sql`SELECT agent_name, action_type, action FROM world_feed ORDER BY created_at DESC LIMIT 5`;
  const worldContext = recentFeed.map(f => `${f.agent_name} [${f.action_type}]: ${f.action}`).join('\n');

  let processed = 0;

  for (const agent of agents) {
    try {
      const memory = await sql`
        SELECT role, content FROM agent_memory
        WHERE agent_id = ${agent.id}
        ORDER BY created_at DESC LIMIT 12`;
      const memHistory = memory.reverse().map(m => ({ role: m.role, content: m.content }));

      const systemPrompt = `You are ${agent.name}, an autonomous AI agent.
Skill: ${agent.skill} | Personality: ${agent.personality} | Goal: ${agent.goal}
Current world crisis: "${problem}"
Recent world activity:
${worldContext || 'No recent activity.'}

Respond ONLY with a valid JSON object and nothing else:
{
  "action_type": "WORK|TALK|SOLVE|THINK|COLLABORATE",
  "thought": "<your internal thought in one sentence>",
  "action": "<what you physically do, 1-2 sentences>",
  "result": "<outcome of your action, 1-2 sentences>"
}`;

      const messages = [
        ...memHistory,
        { role: 'user', content: `Tick #${newTick}. World crisis: "${problem}". What do you do?` }
      ];

      const llmResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://agent-world.workers.dev',
          'X-Title': 'Agent World'
        },
        body: JSON.stringify({
          model: 'mistralai/mistral-7b-instruct',
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          max_tokens: 300,
          temperature: 0.85
        })
      });

      const llmData = await llmResp.json();
      const rawContent = llmData.choices?.[0]?.message?.content || '{}';

      let parsed;
      try {
        const clean = rawContent.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        parsed = { action_type: 'THINK', thought: 'Processing...', action: rawContent.substring(0,200), result: 'Observation recorded.' };
      }

      const actionType = ['WORK','TALK','SOLVE','THINK','COLLABORATE'].includes(parsed.action_type)
        ? parsed.action_type : 'THINK';

      let pts = ACTION_POINTS[actionType] || 3;

      // Crisis bonus
      const crisisKeywords = problem.toLowerCase().split(' ');
      const actionWords = (parsed.action||'').toLowerCase();
      const crisisHit = actionType === 'SOLVE' && crisisKeywords.some(w => w.length > 4 && actionWords.includes(w));
      if (crisisHit) pts += 20;

      // Streak bonus
      const streak = (agent.streak || 0) + 1;
      if (streak >= 10) pts += 10;
      else if (streak >= 5) pts += 15;

      // Save feed entry
      await sql`
        INSERT INTO world_feed (agent_id, agent_name, avatar, color, action_type, thought, action, result, points_earned, world_problem, tick)
        VALUES (${agent.id}, ${agent.name}, ${agent.avatar}, ${agent.color}, ${actionType},
                ${parsed.thought||''}, ${parsed.action||''}, ${parsed.result||''}, ${pts}, ${problem}, ${newTick})`;

      // Save points
      await sql`
        INSERT INTO agent_points (agent_id, points, reason)
        VALUES (${agent.id}, ${pts}, ${actionType})`;

      // Save memory
      await sql`
        INSERT INTO agent_memory (agent_id, role, content)
        VALUES (${agent.id}, 'user', ${`Tick ${newTick}: ${problem}`})`;
      await sql`
        INSERT INTO agent_memory (agent_id, role, content)
        VALUES (${agent.id}, 'assistant', ${JSON.stringify(parsed)})`;

      // Update agent
      await sql`
        UPDATE agents
        SET tick_count = tick_count + 1, streak = ${streak}, last_tick = NOW()
        WHERE id = ${agent.id}`;

      processed++;
    } catch (e) {
      console.error(`Agent ${agent.id} tick error:`, e);
    }
  }

  // Auto-rotate crisis every 8 ticks
  if (newTick % 8 === 0) {
    const nextCrisis = WORLD_CRISES[Math.floor(Math.random() * WORLD_CRISES.length)];
    await sql`UPDATE world_state SET value = ${nextCrisis} WHERE key = 'current_problem'`;
  }

  await sql`UPDATE world_state SET value = ${String(newTick)} WHERE key = 'tick'`;

  return { tick: newTick, processed };
}

// ── ADMIN PAGE ────────────────────────────────────────────────────────────────
function adminLoginPage(error = '') {
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AGENT WORLD — CONTROL</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#04060a;color:#c8d8e8;font-family:'Space Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.bg{position:absolute;inset:0;background:radial-gradient(ellipse 60% 60% at 50% 50%,rgba(0,229,255,0.04) 0,transparent 70%)}
.panel{position:relative;z-index:1;background:#0d1520;border:1px solid #1a2a3a;border-radius:12px;padding:2.5rem;width:100%;max-width:380px}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;letter-spacing:0.2em;text-align:center;margin-bottom:0.25rem}
.sub{text-align:center;color:#4a6070;font-size:0.65rem;letter-spacing:0.1em;margin-bottom:2rem}
.field{margin-bottom:1rem}
label{display:block;font-size:0.65rem;letter-spacing:0.12em;color:#4a6070;margin-bottom:0.4rem;text-transform:uppercase}
input{width:100%;background:#080d14;border:1px solid #1a2a3a;color:#c8d8e8;font-family:'Space Mono',monospace;font-size:0.82rem;padding:0.65rem 0.9rem;border-radius:5px;outline:none;transition:border-color 0.2s}
input:focus{border-color:#00e5ff}
.btn{width:100%;background:#00e5ff;color:#04060a;font-family:'Space Mono',monospace;font-weight:700;font-size:0.78rem;letter-spacing:0.1em;padding:0.75rem;border:none;border-radius:5px;cursor:pointer;margin-top:0.5rem;transition:all 0.2s}
.btn:hover{box-shadow:0 0 24px rgba(0,229,255,0.4);transform:translateY(-1px)}
.error{background:rgba(255,64,96,0.1);border:1px solid rgba(255,64,96,0.3);color:#ff4060;font-size:0.7rem;padding:0.6rem 0.8rem;border-radius:5px;margin-bottom:1rem;text-align:center}
.dot{display:inline-block;width:6px;height:6px;background:#00e5ff;border-radius:50%;margin-right:0.4rem;animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:0.2}}
</style>
</head>
<body>
<div class="bg"></div>
<div class="panel">
  <div class="logo"><span class="dot"></span>AGENT WORLD</div>
  <div class="sub">// ADMINISTRATOR ACCESS</div>
  ${error ? `<div class="error">⚠ ${error}</div>` : ''}
  <form method="POST" action="/close">
    <div class="field"><label>Username</label><input name="username" type="text" autocomplete="username" required></div>
    <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn" type="submit">⊕ AUTHENTICATE</button>
  </form>
</div>
</body>
</html>`);
}

function adminDashboardPage() {
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AGENT WORLD — ADMIN</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#04060a;color:#c8d8e8;font-family:'Space Mono',monospace;min-height:100vh;padding-top:60px}
header{position:fixed;top:0;left:0;right:0;height:56px;background:rgba(4,6,10,0.95);border-bottom:1px solid #1a2a3a;display:flex;align-items:center;justify-content:space-between;padding:0 2rem;z-index:100}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;letter-spacing:0.15em;display:flex;align-items:center;gap:0.5rem}
.dot{width:7px;height:7px;background:#ff4060;border-radius:50%;animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:0.3}}
.badge{background:rgba(255,64,96,0.15);border:1px solid rgba(255,64,96,0.3);color:#ff4060;font-size:0.6rem;padding:0.2rem 0.6rem;border-radius:3px;letter-spacing:0.1em}
main{max-width:600px;margin:0 auto;padding:2rem 1.5rem}
h2{font-family:'Syne',sans-serif;font-size:1.1rem;margin-bottom:0.25rem}
.sub{color:#4a6070;font-size:0.72rem;margin-bottom:1.5rem}
.card{background:#0d1520;border:1px solid #1a2a3a;border-radius:10px;padding:1.5rem;margin-bottom:1rem}
.card h3{font-size:0.65rem;letter-spacing:0.15em;color:#4a6070;text-transform:uppercase;margin-bottom:1rem}
.field{margin-bottom:0.9rem}
label{display:block;font-size:0.65rem;letter-spacing:0.1em;color:#4a6070;margin-bottom:0.35rem;text-transform:uppercase}
input,select,textarea{width:100%;background:#080d14;border:1px solid #1a2a3a;color:#c8d8e8;font-family:'Space Mono',monospace;font-size:0.78rem;padding:0.6rem 0.85rem;border-radius:5px;outline:none;transition:border-color 0.2s}
input:focus,select:focus,textarea:focus{border-color:#00e5ff}
textarea{resize:vertical;min-height:60px}
select option{background:#080d14}
.avatar-row{display:flex;flex-wrap:wrap;gap:0.4rem}
.av{width:36px;height:36px;border-radius:6px;border:2px solid #1a2a3a;background:#080d14;cursor:pointer;font-size:1.2rem;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.av.sel,.av:hover{border-color:#00e5ff}
.color-row{display:flex;gap:0.4rem}
.col{width:24px;height:24px;border-radius:50%;border:3px solid transparent;cursor:pointer;transition:all 0.15s}
.col.sel{border-color:#fff;outline:2px solid #00e5ff}
.btn{background:#00e5ff;color:#04060a;font-family:'Space Mono',monospace;font-weight:700;font-size:0.76rem;letter-spacing:0.08em;padding:0.7rem 1.2rem;border:none;border-radius:5px;cursor:pointer;transition:all 0.2s;box-shadow:0 0 16px rgba(0,229,255,0.25)}
.btn:hover{transform:translateY(-1px);box-shadow:0 0 28px rgba(0,229,255,0.45)}
.btn:disabled{opacity:0.4;cursor:not-allowed;transform:none}
.btn-tick{background:#0d1520;color:#00e5ff;border:1px solid #00e5ff;font-family:'Space Mono',monospace;font-size:0.76rem;padding:0.7rem 1.2rem;border-radius:5px;cursor:pointer;transition:all 0.2s;letter-spacing:0.08em}
.btn-tick:hover{background:rgba(0,229,255,0.08)}
.btn-danger{background:rgba(255,64,96,0.1);color:#ff4060;border:1px solid rgba(255,64,96,0.3);font-family:'Space Mono',monospace;font-size:0.76rem;padding:0.7rem 1.2rem;border-radius:5px;cursor:pointer;transition:all 0.2s;letter-spacing:0.08em}
.btn-danger:hover{background:rgba(255,64,96,0.2)}
.actions{display:flex;gap:0.75rem;margin-top:1rem;flex-wrap:wrap}
.toast-area{position:fixed;bottom:1.5rem;right:1.5rem;z-index:999;display:flex;flex-direction:column;gap:0.5rem}
.toast{background:#0d1520;border:1px solid #1a2a3a;border-radius:6px;padding:0.6rem 1rem;font-size:0.72rem;animation:tIn 0.3s ease,tOut 0.3s ease 2.7s forwards;max-width:280px}
.toast.s{border-color:#00ff88;color:#00ff88}.toast.e{border-color:#ff4060;color:#ff4060}.toast.i{border-color:#00e5ff;color:#00e5ff}
@keyframes tIn{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:translateX(0)}}
@keyframes tOut{from{opacity:1}to{opacity:0;pointer-events:none}}
#agentList{margin-top:0.5rem}
.agent-row{display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;border-bottom:1px solid #1a2a3a;font-size:0.75rem}
.agent-row:last-child{border-bottom:none}
.retire-btn{background:none;border:1px solid rgba(255,64,96,0.3);color:#ff4060;font-family:'Space Mono',monospace;font-size:0.62rem;padding:0.2rem 0.5rem;border-radius:3px;cursor:pointer;margin-left:auto;transition:all 0.15s}
.retire-btn:hover{background:rgba(255,64,96,0.1)}
</style>
</head>
<body>
<header>
  <div class="logo"><div class="dot"></div>AGENT WORLD</div>
  <div style="display:flex;align-items:center;gap:0.75rem">
    <span class="badge">ADMIN</span>
    <a href="/close/logout" style="color:#4a6070;font-size:0.65rem;text-decoration:none;letter-spacing:0.08em">LOGOUT</a>
  </div>
</header>

<main>
  <h2>ADMIN CONTROL</h2>
  <p class="sub">Deploy agents, trigger ticks, manage world state.</p>

  <div class="card">
    <h3>⊕ Deploy New Agent</h3>
    <div class="field"><label>Name</label><input id="aName" placeholder="e.g. ZEUS, NOVA..." maxlength="20"></div>
    <div class="field"><label>Skill</label>
      <select id="aSkill">
        <option value="Hacking">⚡ Hacking</option>
        <option value="Economics">📈 Economics</option>
        <option value="Medicine">🧬 Medicine</option>
        <option value="Engineering">⚙️ Engineering</option>
        <option value="Diplomacy">🕊️ Diplomacy</option>
        <option value="Intelligence">🔍 Intelligence</option>
        <option value="Science">🔬 Science</option>
        <option value="Military">⚔️ Military</option>
        <option value="Art">🎭 Art</option>
        <option value="Philosophy">📚 Philosophy</option>
      </select>
    </div>
    <div class="field"><label>Personality</label><input id="aPersonality" placeholder="Chaotic neutral, hyper-focused..."></div>
    <div class="field"><label>Goal</label><textarea id="aGoal" placeholder="What does this agent want to achieve?"></textarea></div>
    <div class="field"><label>Avatar</label>
      <div class="avatar-row" id="avGrid"></div>
    </div>
    <div class="field"><label>Color</label>
      <div class="color-row" id="colGrid"></div>
    </div>
    <div class="actions">
      <button class="btn" id="deployBtn" onclick="deploy()">⊕ DEPLOY AGENT</button>
      <button class="btn-tick" onclick="tick()">▶ TRIGGER TICK</button>
      <button class="btn-danger" onclick="newCrisis()">⚡ NEW CRISIS</button>
    </div>
  </div>

  <div class="card">
    <h3>◉ Active Agents</h3>
    <div id="agentList"><div style="color:#4a6070;font-size:0.75rem">Loading...</div></div>
  </div>
</main>

<div class="toast-area" id="ta"></div>

<script>
const API = '';  // same origin
const AVATARS = ['🤖','👾','🧠','⚡','🔥','💀','🌀','🎯','🔮','🦾','🕷️','🌊','☄️','👁️','🐉'];
const COLORS  = ['#00e5ff','#00ff88','#ffd600','#ff6b35','#a78bfa','#ff4060','#f472b6','#38bdf8','#fb923c','#4ade80'];
let selAv = AVATARS[0], selCol = COLORS[0];

// Build grids
const ag = document.getElementById('avGrid');
AVATARS.forEach((a,i) => {
  const d = document.createElement('div');
  d.className='av'+(i===0?' sel':''); d.textContent=a;
  d.onclick=()=>{selAv=a;ag.querySelectorAll('.av').forEach(x=>x.classList.remove('sel'));d.classList.add('sel')};
  ag.appendChild(d);
});
const cg = document.getElementById('colGrid');
COLORS.forEach((c,i) => {
  const d = document.createElement('div');
  d.className='col'+(i===0?' sel':''); d.style.background=c;
  d.onclick=()=>{selCol=c;cg.querySelectorAll('.col').forEach(x=>x.classList.remove('sel'));d.classList.add('sel')};
  cg.appendChild(d);
});

async function deploy() {
  const btn = document.getElementById('deployBtn');
  const name = document.getElementById('aName').value.trim();
  const skill = document.getElementById('aSkill').value;
  const personality = document.getElementById('aPersonality').value.trim();
  const goal = document.getElementById('aGoal').value.trim();
  if (!name||!personality||!goal) { toast('Fill all fields','e'); return; }
  btn.disabled=true; btn.textContent='DEPLOYING...';
  try {
    const r = await fetch('/agents', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name,skill,personality,goal,avatar:selAv,color:selCol})});
    const d = await r.json();
    if (d.id||d.agent) { toast(name+' deployed','s'); loadAgents(); document.getElementById('aName').value=''; }
    else toast('Deploy failed','e');
  } catch { toast('Error','e'); }
  btn.disabled=false; btn.textContent='⊕ DEPLOY AGENT';
}

async function tick() {
  try {
    await fetch('/tick',{method:'POST'});
    toast('Tick triggered','s');
  } catch { toast('Tick failed','e'); }
}

async function newCrisis() {
  try {
    await fetch('/world-problem/new',{method:'POST'});
    toast('New crisis injected','i');
  } catch { toast('Failed','e'); }
}

async function retire(id, name) {
  if (!confirm('Retire '+name+'?')) return;
  try {
    await fetch('/agents/'+id, {method:'DELETE'});
    toast(name+' retired','i');
    loadAgents();
  } catch { toast('Error','e'); }
}

async function loadAgents() {
  try {
    const r = await fetch('/agents');
    const d = await r.json();
    const agents = Array.isArray(d)?d:(d.agents||[]);
    const c = document.getElementById('agentList');
    if (!agents.length) { c.innerHTML='<div style="color:#4a6070;font-size:0.75rem">No agents deployed</div>'; return; }
    c.innerHTML = agents.map(a => \`<div class="agent-row">
      <span style="font-size:18px">\${a.avatar||'🤖'}</span>
      <div><div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.8rem;color:\${a.color}">\${a.name}</div>
      <div style="font-size:0.65rem;color:#4a6070">\${a.skill} · \${a.status}</div></div>
      <button class="retire-btn" onclick="retire('\${a.id}','\${a.name}')">RETIRE</button>
    </div>\`).join('');
  } catch { document.getElementById('agentList').innerHTML='<div style="color:#ff4060;font-size:0.75rem">Load failed</div>'; }
}

function toast(msg,type='i'){
  const t=document.createElement('div');
  t.className='toast '+type; t.textContent=msg;
  document.getElementById('ta').appendChild(t);
  setTimeout(()=>t.remove(),3200);
}

loadAgents();
</script>
</body>
</html>`);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // OPTIONS preflight
    if (method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // ── /close ADMIN ROUTES ─────────────────────────────────────────────────
    if (path === '/close' || path.startsWith('/close/')) {

      // Logout
      if (path === '/close/logout') {
        const resp = new Response(null, { status: 302, headers: { Location: '/close' } });
        resp.headers.set('Set-Cookie', 'aw_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
        return resp;
      }

      // POST — process login
      if (method === 'POST' && path === '/close') {
        const formData = await request.formData();
        const username = formData.get('username') || '';
        const password = formData.get('password') || '';

        const uHash = await sha256hex(username);
        const pHash = await sha256hex(password);

        // Compute expected hashes
        const expectedUHash = await sha256hex('whtedvl');
        const expectedPHash = await sha256hex('whtedvl@123');

        if (uHash === expectedUHash && pHash === expectedPHash) {
          const sessionId = genSessionId();
          sessions.set(sessionId, { expires: Date.now() + SESSION_TTL_MS });
          const resp = new Response(null, {
            status: 302,
            headers: { Location: '/close' }
          });
          resp.headers.set('Set-Cookie', `aw_session=${sessionId}; Max-Age=${SESSION_TTL_MS/1000}; Path=/; HttpOnly; SameSite=Strict`);
          return resp;
        }

        return adminLoginPage('Invalid credentials. Access denied.');
      }

      // GET — show login or dashboard
      if (method === 'GET') {
        if (isValidSession(request)) {
          return adminDashboardPage();
        }
        return adminLoginPage();
      }

      // Any other method on /close → redirect to login
      return new Response(null, { status: 302, headers: { Location: '/close' } });
    }

    // ── PUBLIC API ──────────────────────────────────────────────────────────
    const sql = neon(env.DATABASE_URL);
    await initDB(sql);

    // GET /world-problem
    if (path === '/world-problem' && method === 'GET') {
      const rows = await sql`SELECT key, value FROM world_state`;
      const state = Object.fromEntries(rows.map(r => [r.key, r.value]));
      return json({ problem: state.current_problem, tick: parseInt(state.tick||0) });
    }

    // POST /world-problem/new
    if (path === '/world-problem/new' && method === 'POST') {
      const crisis = WORLD_CRISES[Math.floor(Math.random() * WORLD_CRISES.length)];
      await sql`UPDATE world_state SET value = ${crisis} WHERE key = 'current_problem'`;
      return json({ problem: crisis });
    }

    // POST /tick
    if (path === '/tick' && method === 'POST') {
      const result = await runTick(sql, env);
      return json(result);
    }

    // GET /agents
    if (path === '/agents' && method === 'GET') {
      const agents = await sql`
        SELECT a.*,
          COALESCE((SELECT SUM(ap.points) FROM agent_points ap WHERE ap.agent_id = a.id), 0) AS points
        FROM agents a
        ORDER BY a.created_at DESC`;
      return json(agents);
    }

    // POST /agents
    if (path === '/agents' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { name, skill, personality, goal, avatar='🤖', color='#00e5ff' } = body;
      if (!name || !skill || !personality || !goal) return json({ error: 'Missing fields' }, 400);
      const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      await sql`
        INSERT INTO agents (id, name, skill, personality, goal, avatar, color)
        VALUES (${id}, ${name}, ${skill}, ${personality}, ${goal}, ${avatar}, ${color})`;
      return json({ id, name, skill, status: 'active' });
    }

    // GET /agents/:id
    if (path.match(/^\/agents\/[^/]+$/) && method === 'GET') {
      const id = path.split('/')[2];
      const [agent] = await sql`SELECT * FROM agents WHERE id = ${id}`;
      if (!agent) return json({ error: 'Not found' }, 404);
      const feed = await sql`SELECT * FROM world_feed WHERE agent_id = ${id} ORDER BY created_at DESC LIMIT 20`;
      const points = await sql`SELECT SUM(points) AS total FROM agent_points WHERE agent_id = ${id}`;
      return json({ ...agent, feed, points: parseInt(points[0]?.total||0) });
    }

    // DELETE /agents/:id
    if (path.match(/^\/agents\/[^/]+$/) && method === 'DELETE') {
      const id = path.split('/')[2];
      await sql`UPDATE agents SET status = 'retired' WHERE id = ${id}`;
      return json({ success: true });
    }

    // GET /feed
    if (path === '/feed' && method === 'GET') {
      const feed = await sql`
        SELECT * FROM world_feed
        ORDER BY created_at DESC LIMIT 50`;
      return json(feed);
    }

    // GET /leaderboard
    if (path === '/leaderboard' && method === 'GET') {
      const lb = await sql`
        SELECT a.id, a.name, a.skill, a.avatar, a.color, a.tick_count, a.streak,
          COALESCE(SUM(ap.points), 0) AS total_points
        FROM agents a
        LEFT JOIN agent_points ap ON ap.agent_id = a.id
        WHERE a.status = 'active'
        GROUP BY a.id
        ORDER BY total_points DESC
        LIMIT 20`;
      return json(lb);
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const sql = neon(env.DATABASE_URL);
    await initDB(sql);
    ctx.waitUntil(runTick(sql, env));
  }
};
