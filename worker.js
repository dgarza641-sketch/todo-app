import 'dotenv/config';
import { initializeDatabase, pool } from './db.js';

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_FROM) {
    console.log(`Reminder due for ${to}: ${subject} (email is not configured)`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.ALERT_FROM, to: [to], subject, html })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

async function checkReminders() {
  const { rows } = await pool.query(`
    SELECT t.id, t.title, t.due_at, s.alert_email, s.timezone
    FROM tasks t CROSS JOIN settings s
    WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.reminder_sent_at IS NULL
      AND s.alert_email IS NOT NULL
      AND t.due_at - (t.reminder_minutes * INTERVAL '1 minute') <= NOW()
      AND t.due_at > NOW() - INTERVAL '1 hour'
  `);
  for (const task of rows) {
    try {
      const dueTime = new Date(task.due_at).toLocaleString('en-US', { timeZone: task.timezone, dateStyle: 'medium', timeStyle: 'short' });
      await sendEmail(task.alert_email, `Reminder: ${task.title}`, `<p><strong>${task.title}</strong> is due at ${dueTime}.</p>`);
      await pool.query('UPDATE tasks SET reminder_sent_at = NOW() WHERE id = $1 AND reminder_sent_at IS NULL', [task.id]);
    } catch (error) { console.error(`Could not alert for task ${task.id}`, error); }
  }
}

await initializeDatabase();
await checkReminders();
setInterval(() => checkReminders().catch(console.error), 60_000);
console.log('Reminder worker is running');
