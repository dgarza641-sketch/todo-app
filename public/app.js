const taskList = document.querySelector('#task-list');
const emptyState = document.querySelector('#empty-state');
const taskTemplate = document.querySelector('#task-template');
const toast = document.querySelector('#toast');
let tasks = [];

function showToast(message, isError = false) {
  toast.textContent = message; toast.className = isError ? 'visible error' : 'visible';
  setTimeout(() => { toast.className = ''; }, 3500);
}

async function api(url, options) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Please try again.'); }
  return response.status === 204 ? null : response.json();
}

function relativeDue(dateString) {
  if (!dateString) return 'No due date';
  const due = new Date(dateString), now = new Date();
  const sameDay = due.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const day = sameDay ? 'Today' : due.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function render() {
  taskList.innerHTML = '';
  const openTasks = tasks.filter(task => !task.completed_at);
  document.querySelector('#task-count').textContent = openTasks.length ? `${openTasks.length} open` : '';
  emptyState.hidden = Boolean(openTasks.length);
  for (const task of tasks) {
    if (task.completed_at) continue;
    const card = taskTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector('h3').textContent = task.title;
    const notes = card.querySelector('.task-notes'); notes.textContent = task.notes; notes.hidden = !task.notes;
    const due = card.querySelector('.due'); due.textContent = relativeDue(task.due_at); due.classList.toggle('no-date', !task.due_at);
    card.querySelector('.complete').addEventListener('click', async () => { await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: true }) }); await loadTasks(); });
    card.querySelector('.delete-task').addEventListener('click', async () => { if (!confirm(`Delete “${task.title}”?`)) return; await api(`/api/tasks/${task.id}`, { method: 'DELETE' }); await loadTasks(); });
    card.querySelector('.calendar-task').addEventListener('click', async () => {
      try { const result = await api(`/api/tasks/${task.id}/calendar`, { method: 'POST' }); showToast('Sent to Google Calendar.'); if (result.eventUrl) window.open(result.eventUrl, '_blank', 'noopener'); }
      catch (error) { showToast(error.message, true); }
    });
    taskList.append(card);
  }
}

async function loadTasks() { tasks = await api('/api/tasks'); render(); }

async function loadAgenda() {
  const events = await api('/api/calendar/events');
  const section = document.querySelector('#agenda-section');
  const list = document.querySelector('#agenda-list');
  section.hidden = !events.length;
  list.innerHTML = events.map(event => `<div class="agenda-event"><span>${event.allDay ? new Date(`${event.startsAt}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : relativeDue(event.startsAt)}</span><strong>${escapeHtml(event.title)}</strong></div>`).join('');
}

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }

document.querySelector('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = Object.fromEntries(new FormData(form));
    if (data.dueAt) data.dueAt = new Date(data.dueAt).toISOString();
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(data) });
    form.reset(); document.querySelector('#reminder-minutes').value = '15'; await loadTasks(); showToast('Task added.');
  } catch (error) { showToast(error.message, true); }
});

const dialog = document.querySelector('#settings-dialog');
document.querySelector('#settings-button').addEventListener('click', () => dialog.showModal());
document.querySelector('#notifications-button').addEventListener('click', async () => {
  if (!('Notification' in window)) return showToast('This browser does not support alerts.', true);
  const permission = await Notification.requestPermission();
  showToast(permission === 'granted' ? 'Browser alerts are ready.' : 'Browser alerts were not enabled.', permission !== 'granted');
});
document.querySelector('#settings-form').addEventListener('submit', async event => {
  if (event.submitter?.value !== 'save') return;
  event.preventDefault();
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ alertEmail: document.querySelector('#alert-email').value, timezone: document.querySelector('#timezone').value }) }); dialog.close(); showToast('Preferences saved.'); }
  catch (error) { showToast(error.message, true); }
});

async function loadStatus() {
  const status = await api('/api/status');
  document.querySelector('#alert-email').value = status.alert_email || '';
  document.querySelector('#timezone').value = status.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendarLink = document.querySelector('#calendar-link');
  if (status.calendar_connected) { calendarLink.textContent = 'Google Calendar connected'; calendarLink.classList.add('connected'); loadAgenda().catch(() => {}); }
  if (!status.googleConfigured) calendarLink.title = 'Add Google OAuth credentials on Render first.';
}

function browserAlarm() {
  if (Notification.permission !== 'granted') return;
  const now = Date.now();
  tasks.filter(t => !t.completed_at && t.due_at && new Date(t.due_at).getTime() - (t.reminder_minutes * 60_000) <= now && new Date(t.due_at).getTime() > now - 65_000).forEach(t => new Notification('Daylight reminder', { body: `${t.title} is due ${relativeDue(t.due_at)}.` }));
}

Promise.all([loadStatus(), loadTasks()]).catch(error => showToast(error.message, true));
setInterval(() => { loadTasks().then(browserAlarm).catch(() => {}); }, 60_000);
