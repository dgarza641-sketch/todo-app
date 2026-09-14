import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { google } from 'googleapis';
import { initializeDatabase, pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');

app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'local-development-secret'));
app.use(express.static(path.join(__dirname, 'public')));

function googleClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${appUrl}/auth/google/callback`
  );
}

function configuredGoogle() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function cleanTask(body) {
  const title = String(body.title || '').trim();
  if (!title || title.length > 240) throw new Error('Add a task name (up to 240 characters).');
  const dueAt = body.dueAt ? new Date(body.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error('The due date is not valid.');
  const reminderMinutes = Number.parseInt(body.reminderMinutes ?? 15, 10);
  if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 10080) throw new Error('Reminder must be between 0 minutes and 7 days.');
  return { title, notes: String(body.notes || '').trim(), dueAt, reminderMinutes };
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/auth/google', (req, res) => {
  if (!configuredGoogle()) return res.status(503).send('Google Calendar has not been configured yet.');
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, signed: true, sameSite: 'lax', secure: appUrl.startsWith('https') });
  res.redirect(googleClient().generateAuthUrl({
    access_type: 'offline', prompt: 'consent', state,
    scope: ['https://www.googleapis.com/auth/calendar.events']
  }));
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!req.query.code || req.query.state !== req.signedCookies.oauth_state) return res.status(400).send('This calendar connection link has expired. Please try again.');
    const client = googleClient();
    const { tokens } = await client.getToken(req.query.code);
    await pool.query('UPDATE settings SET google_tokens = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(tokens)]);
    res.clearCookie('oauth_state');
    res.redirect('/?calendar=connected');
  } catch (error) { next(error); }
});

app.get('/api/status', async (_req, res, next) => {
  try {
    const { rows: [settings] } = await pool.query('SELECT google_tokens IS NOT NULL AS calendar_connected, alert_email, timezone FROM settings WHERE id = 1');
    res.json({ ...settings, googleConfigured: configuredGoogle() });
  } catch (error) { next(error); }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const alertEmail = String(req.body.alertEmail || '').trim() || null;
    const timezone = String(req.body.timezone || 'America/Chicago').trim();
    await pool.query('UPDATE settings SET alert_email = $1, timezone = $2, updated_at = NOW() WHERE id = 1', [alertEmail, timezone]);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/tasks', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY completed_at IS NOT NULL, due_at NULLS LAST, created_at DESC');
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/calendar/events', async (_req, res, next) => {
  try {
    const { rows: [settings] } = await pool.query('SELECT google_tokens FROM settings WHERE id = 1');
    if (!settings.google_tokens) return res.json([]);
    const client = googleClient(); client.setCredentials(settings.google_tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const response = await calendar.events.list({
      calendarId: 'primary', timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 8
    });
    res.json((response.data.items || []).map(event => ({ id: event.id, title: event.summary || 'Untitled event', startsAt: event.start?.dateTime || event.start?.date, allDay: Boolean(event.start?.date) })));
  } catch (error) { next(error); }
});

app.post('/api/tasks', async (req, res, next) => {
  try {
    const task = cleanTask(req.body);
    const { rows: [created] } = await pool.query(
      'INSERT INTO tasks (title, notes, due_at, reminder_minutes) VALUES ($1, $2, $3, $4) RETURNING *',
      [task.title, task.notes, task.dueAt, task.reminderMinutes]
    );
    res.status(201).json(created);
  } catch (error) { next(error); }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (Object.hasOwn(req.body, 'completed')) {
      const { rows: [task] } = await pool.query('UPDATE tasks SET completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END, updated_at = NOW() WHERE id = $2 RETURNING *', [Boolean(req.body.completed), id]);
      return task ? res.json(task) : res.sendStatus(404);
    }
    const task = cleanTask(req.body);
    const { rows: [updated] } = await pool.query('UPDATE tasks SET title=$1, notes=$2, due_at=$3, reminder_minutes=$4, reminder_sent_at=NULL, updated_at=NOW() WHERE id=$5 RETURNING *', [task.title, task.notes, task.dueAt, task.reminderMinutes, id]);
    updated ? res.json(updated) : res.sendStatus(404);
  } catch (error) { next(error); }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.sendStatus(result.rowCount ? 204 : 404);
  } catch (error) { next(error); }
});

app.post('/api/tasks/:id/calendar', async (req, res, next) => {
  try {
    const { rows: [settings] } = await pool.query('SELECT google_tokens FROM settings WHERE id = 1');
    const { rows: [task] } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!task) return res.sendStatus(404);
    if (!settings.google_tokens) return res.status(409).json({ error: 'Connect Google Calendar first.' });
    if (!task.due_at) return res.status(422).json({ error: 'Add a due date before sending this task to Calendar.' });
    const client = googleClient(); client.setCredentials(settings.google_tokens);
    const start = new Date(task.due_at), end = new Date(start.getTime() + 30 * 60 * 1000);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const event = { summary: `Task: ${task.title}`, description: task.notes || undefined, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: task.reminder_minutes }] } };
    const response = task.calendar_event_id
      ? await calendar.events.update({ calendarId: 'primary', eventId: task.calendar_event_id, requestBody: event })
      : await calendar.events.insert({ calendarId: 'primary', requestBody: event });
    await pool.query('UPDATE tasks SET calendar_event_id = $1, updated_at = NOW() WHERE id = $2', [response.data.id, task.id]);
    res.json({ eventUrl: response.data.htmlLink });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Something went wrong.' });
});

initializeDatabase().then(() => app.listen(port, '0.0.0.0', () => console.log(`Daylight is running on ${port}`))).catch(error => { console.error('Database setup failed', error); process.exit(1); });
