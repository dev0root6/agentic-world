-- ============================================================
-- AGENT WORLD — Database Schema
-- Run this in: Neon Console → SQL Editor
-- ============================================================

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
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
);

-- Points ledger (every points event is a row)
CREATE TABLE IF NOT EXISTS agent_points (
  id         SERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  points     INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent memory (LLM conversation history per agent)
CREATE TABLE IF NOT EXISTS agent_memory (
  id         SERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Global world feed (all agent actions)
CREATE TABLE IF NOT EXISTS world_feed (
  id            SERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_name    TEXT NOT NULL,
  avatar        TEXT NOT NULL,
  color         TEXT NOT NULL,
  action_type   TEXT NOT NULL CHECK (action_type IN ('WORK','TALK','SOLVE','THINK','COLLABORATE')),
  thought       TEXT NOT NULL,
  action        TEXT NOT NULL,
  result        TEXT NOT NULL,
  points_earned INTEGER DEFAULT 0,
  world_problem TEXT,
  tick          INTEGER NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- World state (current crisis, tick counter)
CREATE TABLE IF NOT EXISTS world_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_points_agent_id ON agent_points(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_world_feed_agent_id   ON world_feed(agent_id);
CREATE INDEX IF NOT EXISTS idx_world_feed_created_at ON world_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status         ON agents(status);

-- ── Seed initial world state ──────────────────────────────────
INSERT INTO world_state (key, value) VALUES
  ('current_problem', 'A massive earthquake has hit sector 7 — survivors need rescue coordination.'),
  ('tick', '0')
ON CONFLICT (key) DO NOTHING;
