import 'dotenv/config';
import webpush from 'web-push';
import { initializeDatabase, pool } from './db.js';

const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || process.env.ALERT_FROM || 'admin@example.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.log('Push notifications are not configured (missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).');
}

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

async function sendPushToAll(payload) {
  if (!vapidConfigured) return;
  const { rows: subscriptions } = await pool.query('SELECT endpoint, subscription FROM push_subscriptions');
  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        // The device unsubscribed or the subscription expired — clean it up.
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]);
      } else {
        console.error('Could not send a push notification', error);
      }
    }
  }
}

async function checkReminders() {
  const { rows } = await pool.query(`
    SELECT t.id, t.title, t.due_at, s.alert_email, s.timezone
    FROM tasks t CROSS JOIN settings s
    WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.reminder_sent_at IS NULL
      AND t.due_at - (t.reminder_minutes * INTERVAL '1 minute') <= NOW()
      AND t.due_at > NOW() - INTERVAL '1 hour'
  `);
  for (const task of rows) {
    try {
      const dueTime = new Date(task.due_at).toLocaleString('en-US', { timeZone: task.timezone, dateStyle: 'medium', timeStyle: 'short' });
      if (task.alert_email) {
        await sendEmail(task.alert_email, `Reminder: ${task.title}`, `<p><strong>${task.title}</strong> is due at ${dueTime}.</p>`);
      }
      await sendPushToAll({ title: 'Daylight reminder', body: `${task.title} is due ${dueTime}.`, taskId: task.id });
      await pool.query('UPDATE tasks SET reminder_sent_at = NOW() WHERE id = $1 AND reminder_sent_at IS NULL', [task.id]);
    } catch (error) { console.error(`Could not alert for task ${task.id}`, error); }
  }
}

await initializeDatabase();
await checkReminders();
setInterval(() => checkReminders().catch(console.error), 60_000);
console.log('Reminder worker is running');
