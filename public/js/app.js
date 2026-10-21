import { api, setUnauthorizedHandler } from './api.js';

const PAGE_SIZE = 12;
const POLL_MS = 30_000;
const PAGES = ['home', 'announcements', 'send'];
const DAY_MS = 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const emptyStats = () => ({ total: 0, important: 0, last24h: 0, latest: null });

const state = {
  user: null,
  items: [],
  total: 0,
  stats: emptyStats(),
  priority: 'all',
  query: '',
  editing: null, // the announcement being edited, or null when writing a new one
  mode: 'login', // 'login' | 'register'
};

let listRequestId = 0;
let pollTimer = null;
let searchTimer = null;
let toastTimer = null;

const isAdmin = () => state.user?.role === 'admin';

/* =====================================================
   SMALL HELPERS
   ===================================================== */

/** Builds an element. Text is always set with textContent, so user content cannot inject HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function relativeTime(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeElement(iso) {
  return el('time', {
    datetime: iso,
    'data-rel': true,
    title: new Date(iso).toLocaleString('en-IN'),
    text: relativeTime(iso),
  });
}

function toast(message, kind = 'info') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

function askConfirm({ title, text, confirmLabel }) {
  const dialog = $('confirmDialog');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(text));

  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = confirmLabel;
  dialog.returnValue = '';

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

/* =====================================================
   LOGIN / SIGN UP
   ===================================================== */

function setAuthMode(mode) {
  state.mode = mode;
  const register = mode === 'register';

  for (const tab of document.querySelectorAll('.auth-tab')) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  $('nameField').hidden = !register;
  $('authTitle').textContent = register ? 'Create your account' : 'Welcome back';
  $('authSubtitle').textContent = register
    ? 'Sign up as a student to see classroom updates'
    : 'Log in to see classroom updates';
  $('authSubmit').textContent = register ? 'Create account' : 'Log in';
  $('authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('authPassword').placeholder = register ? 'At least 8 characters' : 'Enter your password';
  $('authNote').textContent = register
    ? 'Sign-ups create student accounts. Teacher accounts are created by an admin.'
    : 'Teachers: log in with the account your admin created for you.';
  showError('authError', '');
}

function validateAuthInput({ name, email, password }) {
  const register = state.mode === 'register';
  if (register && name.length < 2) return { field: 'authName', message: 'Enter your full name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { field: 'authEmail', message: 'Enter a valid email address.' };
  if (register && password.length < 8) return { field: 'authPassword', message: 'Password must be at least 8 characters.' };
  if (!password) return { field: 'authPassword', message: 'Enter your password.' };
  return null;
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const submit = $('authSubmit');
  if (submit.disabled) return;

  const register = state.mode === 'register';
  const input = {
    name: $('authName').value.trim(),
    email: $('authEmail').value.trim(),
    password: $('authPassword').value,
  };

  const problem = validateAuthInput(input);
  if (problem) {
    showError('authError', problem.message);
    $(problem.field).focus();
    return;
  }

  showError('authError', '');
  submit.disabled = true;
  submit.textContent = 'Please wait…';

  try {
    const { user } = register
      ? await api.register(input)
      : await api.login({ email: input.email, password: input.password });

    $('authForm').reset();
    setPasswordVisible(false);
    enterApp(user);
  } catch (error) {
    showError('authError', error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = state.mode === 'register' ? 'Create account' : 'Log in';
  }
}

function setPasswordVisible(visible) {
  const button = $('togglePassword');
  $('authPassword').type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
}

/* =====================================================
   ENTERING AND LEAVING THE APP
   ===================================================== */

function enterApp(user) {
  state.user = user;

  document.body.classList.toggle('role-admin', user.role === 'admin');
  document.body.classList.toggle('role-student', user.role !== 'admin');
  $('userName').textContent = user.name;
  $('userRole').textContent = user.role === 'admin' ? 'Admin' : 'Student';
  $('postingAs').textContent = user.name;

  $('splash').hidden = true;
  $('loginPage').hidden = true;
  $('app').hidden = false;

  resetBlastForm();
  renderStats();
  renderList();

  const start = pageFromHash() ?? defaultPage();
  if (location.hash !== `#${start}`) history.replaceState(null, '', `#${start}`);
  showPage(start);

  loadList();
  startPolling();
}

function leaveApp(message = '') {
  stopPolling();
  listRequestId += 1; // ignore any request still in flight

  state.user = null;
  state.items = [];
  state.total = 0;
  state.stats = emptyStats();
  state.priority = 'all';
  state.query = '';
  state.editing = null;

  $('searchInput').value = '';
  syncFilterButtons();
  resetBlastForm();

  document.body.classList.remove('role-admin', 'role-student');
  $('app').hidden = true;
  $('splash').hidden = true;
  $('loginPage').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);

  setAuthMode('login');
  showError('authError', message);
  $('authEmail').focus();
}

async function onLogout() {
  let message = '';
  try {
    await api.logout();
  } catch (error) {
    if (error.status === 0) message = 'Could not reach the server, so you may still be logged in on this device.';
  }
  leaveApp(message);
}

/* =====================================================
   PAGES
   ===================================================== */

const defaultPage = () => (isAdmin() ? 'home' : 'announcements');

function pageFromHash() {
  const name = location.hash.slice(1);
  return PAGES.includes(name) && (name !== 'send' || isAdmin()) ? name : null;
}

function showPage(name) {
  if (!state.user) return;
  if (!PAGES.includes(name) || (name === 'send' && !isAdmin())) name = defaultPage();

  // Leaving the form while editing cancels the edit.
  if (name !== 'send' && state.editing) resetBlastForm();

  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('active-page', page.id === name);
  }
  for (const link of document.querySelectorAll('.nav-link')) {
    const active = link.dataset.page === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  $(name).querySelector('h1, h2')?.focus({ preventScroll: true });
}

function navigate(name) {
  if (location.hash === `#${name}`) showPage(name);
  else location.hash = name; // triggers "hashchange", which calls showPage
}

/* =====================================================
   ANNOUNCEMENT LIST
   ===================================================== */

function renderCard(item) {
  const priority = item.priority === 'important' ? 'important' : 'normal';
  const isNew = Date.now() - Date.parse(item.createdAt) < DAY_MS;
  const edited = item.updatedAt !== item.createdAt;
  const mine = isAdmin() && item.teacherId === state.user.id;

  return el(
    'article',
    { class: `blast-card ${priority}` },
    el(
      'div',
      { class: 'badge-row' },
      el('span', { class: `badge ${priority}`, text: priority.toUpperCase() }),
      isNew ? el('span', { class: 'badge new', text: 'NEW' }) : null,
    ),
    el('h3', { text: item.subject }),
    el('div', { class: 'blast-meta' }, `${item.teacher} · `, timeElement(item.createdAt), edited ? ' · edited' : null),
    el('p', { class: 'blast-message', text: item.message }),
    mine
      ? el(
          'div',
          { class: 'card-actions' },
          el('button', { type: 'button', class: 'link-btn', 'aria-label': `Edit ${item.subject}`, onclick: () => startEdit(item), text: 'Edit' }),
          el('button', { type: 'button', class: 'link-btn danger', 'aria-label': `Delete ${item.subject}`, onclick: () => onDelete(item), text: 'Delete' }),
        )
      : null,
  );
}

function renderList() {
  const grid = $('blastGrid');
  grid.replaceChildren(...state.items.map(renderCard));

  if (state.items.length === 0) {
    const filtered = state.query || state.priority !== 'all';
    let text = 'No announcements yet. Check back soon.';
    if (filtered) text = 'No announcements match your search or filter.';
    else if (isAdmin()) text = 'No announcements yet. Use the Send Blast tab to post the first one.';
    grid.append(el('div', { class: 'empty-state', text }));
  }

  $('loadMoreBtn').hidden = state.items.length >= state.total;
  $('listStatus').textContent = state.total
    ? `Showing ${state.items.length} of ${state.total} announcement${state.total === 1 ? '' : 's'}`
    : '';
}

function renderStats() {
  const { total, important, last24h, latest } = state.stats;
  $('statTotal').textContent = total;
  $('statImportant').textContent = important;
  $('statRecent').textContent = last24h;

  if (latest) {
    $('latestTitle').textContent = latest.subject;
    $('latestMessage').textContent = latest.message;
    $('latestMeta').textContent = `${latest.teacher} · ${relativeTime(latest.createdAt)}`;
  } else {
    $('latestTitle').textContent = 'No announcements yet';
    $('latestMessage').textContent = isAdmin()
      ? 'Create your first classroom announcement.'
      : 'Nothing has been posted yet.';
    $('latestMeta').textContent = '';
  }
}

/**
 * Loads announcements from the server.
 *  append: add the next page to the list.
 *  silent: background refresh (no loading message, keeps the same number of items).
 */
async function loadList({ append = false, silent = false } = {}) {
  const requestId = ++listRequestId;
  const status = $('listStatus');

  if (!silent) {
    $('blastGrid').setAttribute('aria-busy', 'true');
    if (state.items.length === 0) status.textContent = 'Loading…';
  }

  const limit = append || !silent ? PAGE_SIZE : Math.min(100, Math.max(PAGE_SIZE, state.items.length));

  try {
    const data = await api.list({
      priority: state.priority,
      q: state.query,
      limit,
      offset: append ? state.items.length : 0,
    });
    if (requestId !== listRequestId) return; // a newer request replaced this one

    state.items = append ? [...state.items, ...data.items] : data.items;
    state.total = data.total;
    state.stats = data.stats;
    renderList();
    renderStats();
  } catch (error) {
    if (requestId !== listRequestId) return;
    if (!silent) {
      status.textContent = '';
      toast(error.message, 'error');
    }
  } finally {
    if (requestId === listRequestId) $('blastGrid').removeAttribute('aria-busy');
  }
}

function syncFilterButtons() {
  for (const button of document.querySelectorAll('.filter-btn')) {
    const active = button.dataset.type === state.priority;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden && state.user) loadList({ silent: true });
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/* =====================================================
   SEND / EDIT / DELETE (admins)
   ===================================================== */

function applyFormMode() {
  const editing = Boolean(state.editing);
  $('sendTitle').textContent = editing ? 'Edit Announcement' : 'Send a Classroom Blast';
  $('blastSubmit').textContent = editing ? 'Save changes' : '+ Send Blast';
  $('cancelEditBtn').hidden = !editing;
}

function updateCounter() {
  $('messageCounter').textContent = `${$('message').value.length} / 1000`;
}

function resetBlastForm() {
  state.editing = null;
  $('blastForm').reset();
  showError('blastError', '');
  updateCounter();
  applyFormMode();
}

function startEdit(item) {
  state.editing = item;
  $('subject').value = item.subject;
  $('priority').value = item.priority;
  $('message').value = item.message;
  showError('blastError', '');
  updateCounter();
  applyFormMode();
  navigate('send');
  $('subject').focus();
}

async function onBlastSubmit(event) {
  event.preventDefault();
  const submit = $('blastSubmit');
  if (submit.disabled) return;

  const payload = {
    subject: $('subject').value.trim(),
    message: $('message').value.trim(),
    priority: $('priority').value,
  };

  if (!payload.subject || !payload.message) {
    showError('blastError', 'Please fill in the subject and the announcement.');
    (payload.subject ? $('message') : $('subject')).focus();
    return;
  }

  const wasEditing = Boolean(state.editing);
  showError('blastError', '');
  submit.disabled = true;

  try {
    if (wasEditing) await api.update(state.editing.id, payload);
    else await api.create(payload);

    // Show the full list so the person can see what they just posted.
    if (!wasEditing) {
      state.priority = 'all';
      state.query = '';
      $('searchInput').value = '';
      syncFilterButtons();
    }

    resetBlastForm();
    toast(wasEditing ? 'Announcement updated' : 'Announcement sent');
    navigate('announcements');
    loadList();
  } catch (error) {
    showError('blastError', error.message);
  } finally {
    submit.disabled = false;
  }
}

async function onDelete(item) {
  const confirmed = await askConfirm({
    title: 'Delete announcement?',
    text: `"${item.subject}" will be removed for everyone. This cannot be undone.`,
    confirmLabel: 'Delete',
  });
  if (!confirmed) return;

  try {
    await api.remove(item.id);
    toast('Announcement deleted');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadList({ silent: true });
}

/* =====================================================
   EVENTS
   ===================================================== */

function wireEvents() {
  for (const tab of document.querySelectorAll('.auth-tab')) {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
  }
  $('authForm').addEventListener('submit', onAuthSubmit);
  $('togglePassword').addEventListener('click', () => setPasswordVisible($('authPassword').type === 'password'));
  $('logoutBtn').addEventListener('click', onLogout);

  window.addEventListener('hashchange', () => {
    if (state.user) showPage(pageFromHash() ?? defaultPage());
  });

  $('filterBar').addEventListener('click', (event) => {
    const button = event.target.closest('.filter-btn');
    if (!button) return;
    state.priority = button.dataset.type;
    syncFilterButtons();
    loadList();
  });

  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = $('searchInput').value.trim();
      loadList();
    }, 300);
  });

  $('loadMoreBtn').addEventListener('click', () => loadList({ append: true }));

  $('blastForm').addEventListener('submit', onBlastSubmit);
  $('message').addEventListener('input', updateCounter);
  $('cancelEditBtn').addEventListener('click', () => {
    resetBlastForm();
    navigate('announcements');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) loadList({ silent: true });
  });

  // Keep "5 min ago" labels fresh.
  setInterval(() => {
    if (!state.user) return;
    for (const node of document.querySelectorAll('time[data-rel]')) node.textContent = relativeTime(node.dateTime);
    renderStats();
  }, 60_000);

  // If the session ends while the app is open (for example it expired), go back to the login screen.
  setUnauthorizedHandler(() => {
    if (state.user) leaveApp('Your session has ended. Please log in again.');
  });
}

async function boot() {
  wireEvents();
  setAuthMode('login');

  try {
    const { user } = await api.me();
    enterApp(user);
  } catch (error) {
    $('splash').hidden = true;
    $('loginPage').hidden = false;
    if (error.status === 0) showError('authError', error.message); // 401 just means "not logged in"
  }
}

boot();
