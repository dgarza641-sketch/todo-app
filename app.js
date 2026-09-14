const taskList = document.querySelector('#task-list');
const emptyState = document.querySelector('#empty-state');
const taskTemplate = document.querySelector('#task-template');
const toast = document.querySelector('#toast');
let tasks = [];
let deferredInstallPrompt;
let audioContext;
const soundedTaskIds = new Set();

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

// Converts an ISO date string into the "YYYY-MM-DDTHH:mm" format
// that <input type="datetime-local"> expects, in the browser's local time.
function toDatetimeLocalValue(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function attachEditHandlers(card, task) {
  const content = card.querySelector('.task-content');
  const actions = card.querySelector('.task-actions');
  const editForm = card.querySelector('.task-edit-form');
  const editTitle = editForm.querySelector('.edit-title');
  const editNotes = editForm.querySelector('.edit-notes');
  const editDue = editForm.querySelector('.edit-due');
  const editReminder = editForm.querySelector('.edit-reminder');

  function openEdit() {
    editTitle.value = task.title;
    editNotes.value = task.notes || '';
    editDue.value = toDatetimeLocalValue(task.due_at);
    editReminder.value = String(task.reminder_minutes ?? 15);
    content.hidden = true;
    actions.hidden = true;
    editForm.hidden = false;
    card.classList.add('editing');
    editTitle.focus();
  }

  function closeEdit() {
    editForm.hidden = true;
    content.hidden = false;
    actions.hidden = false;
    card.classList.remove('editing');
  }

  card.querySelector('.edit-task').addEventListener('click', openEdit);
  editForm.querySelector('.cancel-edit').addEventListener('click', closeEdit);

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const payload = {
        title: editTitle.value,
        notes: editNotes.value,
        reminderMinutes: Number(editReminder.value),
        dueAt: editDue.value ? new Date(editDue.value).toISOString() : null
      };
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Task updated.');
      await loadTasks();
    } catch (error) {
      showToast(error.message, true);
    }
  });
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
    attachEditHandlers(card, task);
    taskList.append(card);
  }
}

async function loadTasks() { tasks = await api('/api/tasks'); render(); }

function playReminderChime() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    [0, 0.19].forEach((offset, index) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.frequency.value = index ? 880 : 660; gain.gain.setValueAtTime(0.0001, now + offset); gain.gain.exponentialRampToValueAtTime(0.12, now + offset + .02); gain.gain.exponentialRampToValueAtTime(.0001, now + offset + .16);
      oscillator.connect(gain).connect(audioContext.destination); oscillator.start(now + offset); oscillator.stop(now + offset + .17);
    });
  } catch { /* Sound depends on device/browser audio permissions. */ }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function registerPushAlerts() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return showToast('Install Daylight to your Home Screen, then enable alerts.', true);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return showToast('Alerts were not enabled.', true);
  playReminderChime();
  try {
    const { publicKey } = await api('/api/push/public-key');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) });
    showToast('Background alerts are ready.');
  } catch (error) { showToast(error.message, true); }
}

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
document.querySelector('#notifications-button').addEventListener('click', registerPushAlerts);
document.querySelector('#copy-calendar-link').addEventListener('click', async () => { await navigator.clipboard.writeText(document.querySelector('#apple-calendar-link').href); showToast('Apple Calendar link copied.'); });
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
  document.querySelector('#apple-calendar-link').href = status.calendarFeedUrl;
  document.querySelector('#apple-calendar-link').textContent = 'Open calendar link';
  if (!status.pushConfigured) document.querySelector('#notifications-button').title = 'Background alerts finish setup after VAPID keys are added on Render.';
}

function browserAlarm() {
  if (Notification.permission !== 'granted') return;
  const now = Date.now();
  tasks.filter(t => !t.completed_at && t.due_at && new Date(t.due_at).getTime() - (t.reminder_minutes * 60_000) <= now && new Date(t.due_at).getTime() > now - 65_000 && !soundedTaskIds.has(t.id)).forEach(t => { soundedTaskIds.add(t.id); new Notification('Daylight reminder', { body: `${t.title} is due ${relativeDue(t.due_at)}.` }); playReminderChime(); });
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; document.querySelector('#install-button').hidden = false; });
document.querySelector('#install-button').addEventListener('click', async () => {
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; document.querySelector('#install-button').hidden = true; }
  else showToast('On iPhone: tap Share, then Add to Home Screen.');
});

Promise.all([loadStatus(), loadTasks()]).catch(error => showToast(error.message, true));
setInterval(() => { loadTasks().then(browserAlarm).catch(() => {}); }, 60_000);
