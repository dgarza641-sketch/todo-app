# Daylight

Daylight is a small task app designed for a calmer daily plan. It includes a focused task list, due dates, browser reminders, optional email alerts, and one-click Google Calendar event creation.

## What this first version includes

- Create, finish, and delete tasks
- Due dates with configurable reminders (at due time through seven days early)
- Browser notifications while the app is open
- Email reminders through [Resend](https://resend.com) when configured
- Secure Google OAuth connection with the narrow `calendar.events` scope
- One-click create/update of a matching Google Calendar event
- Render Blueprint for the app, reminder worker, and Postgres database

## Run it locally

1. Copy `.env.example` to `.env` and add a Postgres `DATABASE_URL`.
2. Run `npm install`, then `npm run dev`.
3. Open `http://localhost:3000`.

## Deploy to Render

1. Put this project in a GitHub repository and choose **New → Blueprint** in Render.
2. Select the repository. Render reads `render.yaml` and creates the web app, worker, and Postgres database.
3. Set `APP_URL` to the public Render URL exactly (for example, `https://daylight-tasks.onrender.com`).
4. In Google Cloud, enable **Google Calendar API**, create an **OAuth client ID → Web application**, and add this redirect URI:
   `https://YOUR-APP.onrender.com/auth/google/callback`
5. Add its client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Render. Click **Connect Google Calendar** in Daylight.
6. Optional: add `RESEND_API_KEY` and a verified `ALERT_FROM` sender to make the worker email reminders to the address set in Settings.

## Important product notes

This is intentionally a single-user starter. Before inviting other people, add account sign-in and attach tasks/settings to a user ID. Google considers calendar access sensitive; restrict the OAuth test-user list during development, and follow its verification process before making the app broadly public.

For reminders that arrive even when a browser is closed, email is enabled by the worker once Resend is configured. Full mobile push notifications are a good next feature, but require VAPID keys and a service-worker subscription flow.
