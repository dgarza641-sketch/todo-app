import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
      notes TEXT NOT NULL DEFAULT '',
      due_at TIMESTAMPTZ,
      reminder_minutes INTEGER NOT NULL DEFAULT 15 CHECK (reminder_minutes >= 0 AND reminder_minutes <= 10080),
      completed_at TIMESTAMPTZ,
      reminder_sent_at TIMESTAMPTZ,
      calendar_event_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      google_tokens JSONB,
      alert_email TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Chicago',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
