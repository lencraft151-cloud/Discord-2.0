const $ = (selector) => document.querySelector(selector);

const state = {
  token: localStorage.getItem('token'),
  user: null,
  discord: { enabled: false, ready: false, inviteUrl: null },
  servers: [],
  dms: [],
  view: 'home', // 'home' (Direktnachrichten) oder eine Server-ID
  channels: [],
  channel: null, // aktuell geöffneter Kanal oder DM
  messages: [],
  unread: new Set(), // Kanal-IDs mit ungelesenen Nachrichten
  unreadServers: new Set(),
  online: new Set(),
  showMembers: true,
  loadingOlder: false,
  reachedStart: false,
};

let socket = null;

// ---------- Hilfsfunktionen ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'className') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Wie replaceChildren, aber mit Arrays und ausgelassenen (null/false) Einträgen.
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/auth')) {
    logout(false);
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function avatar(person, { large = false, status } = {}) {
  const el = h('span', { className: `avatar${large ? ' large' : ''}` });
  if (person?.avatar) el.style.backgroundImage = `url("${person.avatar}")`;
  else {
    el.style.backgroundColor = person?.color || '#5865f2';
    el.textContent = (person?.displayName || person?.username || '?').slice(0, 1).toUpperCase();
  }
  if (status !== undefined) el.append(h('span', { className: `status${status ? ' online' : ''}` }));
  return el;
}

function formatTime(ts) {
  const date = new Date(ts);
  const today = new Date();
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `Heute um ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Gestern um ${time}`;
  return `${date.toLocaleDateString('de-DE')} ${time}`;
}

// Einfache Formatierung: **fett**, *kursiv*, `code`, Links und Bilder.
function renderContent(text) {
  const container = h('div', { className: 'message-content' });
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s<]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) container.append(h('code', {}, token.slice(1, -1)));
    else if (token.startsWith('**')) container.append(h('strong', {}, token.slice(2, -2)));
    else if (token.startsWith('*')) container.append(h('em', {}, token.slice(1, -1)));
    else {
      container.append(h('a', { href: token, target: '_blank', rel: 'noopener noreferrer' }, token));
      if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(token)) {
        container.append(h('img', { className: 'attachment', src: token, alt: '', loading: 'lazy' }));
      }
    }
    last = match.index + token.length;
  }
  container.append(text.slice(last));
  return container;
}

// ---------- Anmeldung ----------

let registerMode = false;

function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
}

function setAuthMode(register) {
  registerMode = register;
  $('#auth-subtitle').textContent = register ? 'Erstelle ein Konto.' : 'Melde dich an, um weiterzuchatten.';
  $('#auth-submit').textContent = register ? 'Registrieren' : 'Anmelden';
  $('#auth-switch-text').textContent = register ? 'Schon ein Konto?' : 'Noch kein Konto?';
  $('#auth-switch').textContent = register ? 'Anmelden' : 'Registrieren';
  $('#auth-form').password.autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-error').hidden = true;
}

$('#auth-switch').addEventListener('click', () => setAuthMode(!registerMode));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = $('#auth-submit');
  button.disabled = true;
  try {
    const data = await api(registerMode ? '/auth/register' : '/auth/login', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    form.reset();
    await start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

async function logout(callServer = true) {
  if (callServer) await api('/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('token');
  state.token = null;
  socket?.disconnect();
  socket = null;
  showAuth();
}

$('#logout-button').addEventListener('click', () => logout());

// ---------- Start ----------

async function start() {
  const me = await api('/me');
  state.user = me.user;
  state.discord = me.discord;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#me-name').textContent = state.user.username;
  $('#me-avatar').replaceWith(Object.assign(avatar(state.user), { id: 'me-avatar' }));
  connectSocket();
  await Promise.all([loadServers(), loadDms()]);
  await selectView('home');
}

function connectSocket() {
  socket?.disconnect();
  socket = io({ auth: { token: state.token } });
  socket.on('connect_error', (err) => {
    if (err.message === 'Nicht angemeldet') logout(false);
  });
  socket.on('message:new', onMessageNew);
  socket.on('message:update', (message) => {
    const index = state.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) {
      state.messages[index] = message;
      renderMessages({ keepScroll: true });
    }
  });
  socket.on('message:delete', ({ id, channelId }) => {
    if (state.channel?.id !== channelId) return;
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages({ keepScroll: true });
  });
  socket.on('servers:changed', async () => {
    await loadServers();
    if (state.view !== 'home' && !state.servers.some((s) => s.id === state.view)) await selectView('home');
  });
  socket.on('channels:changed', async ({ serverId }) => {
    if (state.view !== serverId) return;
    await loadChannels();
    if (state.channel && !state.channels.some((c) => c.id === state.channel.id)) openChannel(state.channels[0]);
  });
  socket.on('presence', ({ userId, online }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    if (state.view !== 'home' && state.showMembers) renderMembers();
  });
  socket.on('typing', onTyping);
}

// ---------- Server-Leiste ----------

async function loadServers() {
  state.servers = await api('/servers');
  renderServers();
}

function renderServers() {
  const list = $('#server-list');
  list.replaceChildren(
    ...state.servers.map((server) => {
      const label = server.name
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .slice(0, 3);
      const classes = ['rail-item'];
      if (state.view === server.id) classes.push('active');
      if (state.unreadServers.has(server.id)) classes.push('unread');
      return h(
        'button',
        { className: classes.join(' '), title: server.bridged ? `${server.name} (Discord)` : server.name, onclick: () => selectView(server.id) },
        server.iconUrl ? h('img', { src: server.iconUrl, alt: '' }) : label,
        server.bridged && h('span', { className: 'discord-dot' }),
      );
    }),
  );
  $('#home-button').classList.toggle('active', state.view === 'home');
  $('#home-button').classList.toggle('unread', state.dms.some((dm) => state.unread.has(dm.id)));
}

$('#home-button').addEventListener('click', () => selectView('home'));
$('#add-server-button').addEventListener('click', openAddServerDialog);
$('#discover-button').addEventListener('click', openDiscoverDialog);

async function selectView(view) {
  state.view = view;
  state.unreadServers.delete(view);
  renderServers();
  $('#app').classList.remove('nav-open');
  if (view === 'home') {
    $('#sidebar-title').textContent = 'Direktnachrichten';
    $('#sidebar-action').hidden = false;
    $('#sidebar-action').title = 'Neue Direktnachricht';
    $('#members-toggle').hidden = true;
    $('#members').hidden = true;
    renderSidebar();
    if (state.channel?.type === 'dm') openChannel(state.dms.find((d) => d.id === state.channel.id) ?? state.dms[0]);
    else openChannel(state.dms[0]);
  } else {
    const server = currentServer();
    $('#sidebar-title').textContent = server.name;
    $('#sidebar-action').hidden = !server.isOwner;
    $('#sidebar-action').title = 'Kanal erstellen';
    $('#members-toggle').hidden = false;
    await loadChannels();
    openChannel(state.channels[0]);
    renderMembers();
  }
}

function currentServer() {
  return state.servers.find((s) => s.id === state.view);
}

// ---------- Seitenleiste ----------

async function loadChannels() {
  state.channels = await api(`/servers/${state.view}/channels`);
  renderSidebar();
}

async function loadDms() {
  state.dms = await api('/dms');
  if (state.view === 'home') renderSidebar();
  renderServers();
}

function renderSidebar() {
  const list = $('#sidebar-list');
  if (state.view === 'home') {
    fill(
      list,
      h('button', { className: 'list-item', onclick: openNewDmDialog }, h('span', { className: 'hash' }, '✉'), h('span', { className: 'name' }, 'Neue Nachricht')),
      h('div', { className: 'sidebar-section' }, 'Direktnachrichten'),
      state.dms.length
        ? state.dms.map((dm) =>
            h(
              'button',
              { className: itemClass(dm), onclick: () => openChannel(dm) },
              avatar(dm.recipient, { status: dm.recipient?.source === 'local' ? state.online.has(dm.recipient.id) : undefined }),
              h('span', { className: 'name' }, dm.name),
              dm.recipient?.source === 'discord' && h('span', { className: 'badge discord' }, 'Discord'),
            ),
          )
        : h('p', { className: 'muted small', style: 'padding: 0 8px' }, 'Noch keine Gespräche. Schreib jemandem – auch Leuten auf Discord!'),
    );
    return;
  }

  const server = currentServer();
  fill(
    list,
    server.bridged
      ? h('div', { className: 'server-info' }, h('span', {}, h('span', { className: 'badge discord' }, 'Discord'), ' Dieser Server ist mit Discord verbunden. Nachrichten erscheinen dort mit „(D2)“ hinter deinem Namen.'))
      : server.inviteCode && h('div', { className: 'server-info' }, h('span', { className: 'muted' }, 'Einladungscode für Freunde:'), h('code', {}, server.inviteCode)),
    h('div', { className: 'sidebar-section' }, 'Textkanäle'),
    state.channels.map((channel) =>
      h('button', { className: itemClass(channel), onclick: () => openChannel(channel) }, h('span', { className: 'hash' }, '#'), h('span', { className: 'name' }, channel.name)),
    ),
    !server.isOwner && h('button', { className: 'list-item', style: 'margin-top: 16px', onclick: () => leaveServer(server) }, h('span', { className: 'hash' }, '⎋'), h('span', { className: 'name' }, 'Server verlassen')),
  );
}

function itemClass(channel) {
  const classes = ['list-item'];
  if (state.channel?.id === channel.id) classes.push('active');
  if (state.unread.has(channel.id)) classes.push('unread');
  return classes.join(' ');
}

$('#sidebar-action').addEventListener('click', () => {
  if (state.view === 'home') openNewDmDialog();
  else openCreateChannelDialog();
});

$('#menu-button').addEventListener('click', () => $('#app').classList.toggle('nav-open'));

async function leaveServer(server) {
  if (!confirm(`„${server.name}“ wirklich verlassen?`)) return;
  try {
    await api(`/servers/${server.id}/membership`, { method: 'DELETE' });
    await loadServers();
    await selectView('home');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Mitglieder ----------

$('#members-toggle').addEventListener('click', () => {
  state.showMembers = !state.showMembers;
  renderMembers();
});

async function renderMembers() {
  const panel = $('#members');
  if (state.view === 'home' || !state.showMembers) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const serverId = state.view;
  try {
    const { local, discord } = await api(`/servers/${serverId}/members`);
    if (state.view !== serverId) return;
    for (const member of local) if (member.online) state.online.add(member.id);
    const localItems = local.map((member) =>
      h(
        'button',
        { className: 'list-item', onclick: () => member.id !== state.user.id && startDm({ userId: member.id }), title: member.id === state.user.id ? 'Das bist du' : 'Nachricht senden' },
        avatar(member, { status: state.online.has(member.id) }),
        h('span', { className: 'name' }, member.username),
      ),
    );
    const discordItems = discord.map((member) =>
      h(
        'button',
        { className: 'list-item', onclick: () => startDm({ discordUserId: member.id }), title: `@${member.username} – Nachricht senden` },
        avatar(member),
        h('span', { className: 'name' }, member.displayName),
      ),
    );
    fill(
      panel,
      h('div', { className: 'sidebar-section' }, `Discord 2.0 — ${local.length}`),
      localItems,
      discordItems.length > 0 && h('div', { className: 'sidebar-section' }, `Auf Discord — ${discord.length}`),
      discordItems,
    );
  } catch (err) {
    panel.replaceChildren(h('p', { className: 'error' }, err.message));
  }
}

// ---------- Kanal & Nachrichten ----------

async function openChannel(channel) {
  state.channel = channel ?? null;
  state.messages = [];
  state.reachedStart = false;
  $('#typing').textContent = '';
  $('#app').classList.remove('nav-open');
  renderSidebar();

  if (!channel) {
    $('#chat-title').textContent = '';
    $('#chat-bridged').hidden = true;
    $('#composer').hidden = true;
    $('#messages').replaceChildren($('#empty-state') ?? emptyState());
    return;
  }

  state.unread.delete(channel.id);
  renderServers();
  renderSidebar();
  const isDm = channel.type === 'dm';
  $('#chat-title').textContent = isDm ? `@${channel.name}` : `# ${channel.name}`;
  $('#chat-bridged').hidden = !(channel.bridged || channel.recipient?.source === 'discord');
  $('#composer').hidden = false;
  input.value = '';
  autoGrow();
  $('#composer-input').placeholder = isDm ? `Nachricht an @${channel.name}` : `Nachricht an #${channel.name}`;
  $('#messages').replaceChildren(h('p', { className: 'muted', style: 'padding: 16px' }, 'Lade Nachrichten …'));

  try {
    const messages = await api(`/channels/${channel.id}/messages`);
    if (state.channel !== channel) return;
    state.messages = messages;
    state.reachedStart = messages.length < 50;
    renderMessages();
  } catch (err) {
    $('#messages').replaceChildren(h('p', { className: 'error', style: 'padding: 16px' }, err.message));
  }
  if (matchMedia('(min-width: 701px)').matches) $('#composer-input').focus();
}

function emptyState() {
  return h('div', { className: 'empty', id: 'empty-state' }, h('h2', {}, 'Hier ist es noch ruhig'), h('p', {}, 'Tritt einem Server bei oder starte eine Unterhaltung.'));
}

function channelIntro() {
  const channel = state.channel;
  if (channel.type === 'dm') {
    const discord = channel.recipient?.source === 'discord';
    return h(
      'div',
      { className: 'channel-intro' },
      avatar(channel.recipient, { large: true }),
      h('h2', {}, channel.name),
      h(
        'p',
        { className: 'muted' },
        discord
          ? 'Das ist der Anfang deines Gesprächs mit diesem Discord-Nutzer. Deine Nachrichten kommen bei ihm als Direktnachricht vom Brücken-Bot an; seine Antworten landen hier.'
          : 'Das ist der Anfang deines Gesprächs.',
      ),
    );
  }
  return h(
    'div',
    { className: 'channel-intro' },
    h('h2', {}, `Willkommen in #${channel.name}!`),
    h('p', { className: 'muted' }, channel.bridged ? 'Dieser Kanal ist mit einem echten Discord-Kanal verbunden.' : 'Das ist der Anfang dieses Kanals.'),
  );
}

function renderMessages({ keepScroll = false, prependedHeight = null } = {}) {
  const container = $('#messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const previousHeight = container.scrollHeight;
  const previousTop = container.scrollTop;

  const nodes = [];
  if (state.reachedStart) nodes.push(channelIntro());
  let previous = null;
  for (const message of state.messages) {
    const sameAuthor =
      previous &&
      previous.author.source === message.author.source &&
      previous.author.id === message.author.id &&
      previous.author.username === message.author.username &&
      message.createdAt - previous.createdAt < 5 * 60 * 1000;
    nodes.push(
      h(
        'div',
        { className: `message${sameAuthor ? '' : ' first'}`, title: formatTime(message.createdAt) },
        avatar(message.author, { large: true }),
        h(
          'div',
          { className: 'message-meta' },
          h('span', { className: 'message-author', style: message.author.color ? `color: ${message.author.color}` : null }, message.author.username),
          message.author.source === 'discord' && h('span', { className: 'badge discord' }, 'Discord'),
          h('span', { className: 'message-time' }, formatTime(message.createdAt)),
        ),
        h('div', {}, renderContent(message.content), message.editedAt && h('span', { className: 'edited' }, ' (bearbeitet)')),
      ),
    );
    previous = message;
  }
  container.replaceChildren(...nodes);

  if (prependedHeight != null) container.scrollTop = container.scrollHeight - previousHeight + previousTop;
  else if (!keepScroll || atBottom) container.scrollTop = container.scrollHeight;
}

// Ältere Nachrichten nachladen, wenn nach oben gescrollt wird.
$('#messages').addEventListener('scroll', async (event) => {
  const container = event.target;
  if (container.scrollTop > 50 || state.loadingOlder || state.reachedStart || !state.channel || !state.messages.length) return;
  state.loadingOlder = true;
  const channel = state.channel;
  try {
    const older = await api(`/channels/${channel.id}/messages?before=${state.messages[0].id}`);
    if (state.channel !== channel) return;
    state.reachedStart = older.length < 50;
    state.messages = [...older, ...state.messages];
    renderMessages({ prependedHeight: true });
  } finally {
    state.loadingOlder = false;
  }
});

function onMessageNew(message) {
  if (state.channel?.id === message.channelId) {
    if (!state.messages.some((m) => m.id === message.id)) {
      state.messages.push(message);
      renderMessages({ keepScroll: true });
    }
    clearTyping(message.author.username);
    if (document.hidden) state.unread.add(message.channelId);
    return;
  }
  if (message.author.source === 'local' && message.author.id === state.user.id) return;
  state.unread.add(message.channelId);
  if (message.serverId == null) {
    // Neue oder bisher unbekannte DM -> Liste neu laden (sortiert nach Aktivität).
    loadDms();
  } else {
    if (state.view !== message.serverId) state.unreadServers.add(message.serverId);
    renderServers();
    if (state.view === message.serverId) renderSidebar();
  }
}

// ---------- Schreiben ----------

const input = $('#composer-input');

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

let lastTypingSent = 0;
input.addEventListener('input', () => {
  autoGrow();
  if (state.channel && Date.now() - lastTypingSent > 3000) {
    lastTypingSent = Date.now();
    socket?.emit('typing', { channelId: state.channel.id });
  }
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

function sendMessage() {
  const content = input.value.trim();
  if (!content || !state.channel || !socket) return;
  const draft = input.value;
  input.value = '';
  autoGrow();
  lastTypingSent = 0;
  socket.emit('message:send', { channelId: state.channel.id, content }, (response) => {
    if (!response.ok) {
      toast(response.error, true);
      if (!input.value) {
        input.value = draft;
        autoGrow();
      }
    } else if (state.channel?.type === 'dm' && state.dms[0]?.id !== state.channel.id) {
      loadDms();
    }
  });
}

// ---------- Tipp-Anzeige ----------

const typers = new Map(); // username -> Timer

function onTyping({ channelId, username }) {
  if (state.channel?.id !== channelId) return;
  clearTimeout(typers.get(username));
  typers.set(username, setTimeout(() => clearTyping(username), 5000));
  renderTyping();
}

function clearTyping(username) {
  clearTimeout(typers.get(username));
  typers.delete(username);
  renderTyping();
}

function renderTyping() {
  const names = [...typers.keys()];
  $('#typing').textContent =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} schreibt …` : `${names.slice(0, 3).join(', ')} schreiben …`;
}

// ---------- Dialoge ----------

function openModal(...content) {
  fill($('#modal-body'), content);
  $('#modal').hidden = false;
  $('#modal-body').querySelector('input')?.focus();
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modal-body').replaceChildren();
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (event) => event.target === event.currentTarget && closeModal());
document.addEventListener('keydown', (event) => event.key === 'Escape' && closeModal());

function inlineForm({ placeholder, button, onsubmit, maxlength = 100 }) {
  const field = h('input', { placeholder, required: true, maxlength });
  const error = h('p', { className: 'error', hidden: true });
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        try {
          await onsubmit(field.value.trim());
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      },
    },
    field,
    h('button', { className: 'primary', type: 'submit' }, button),
  );
  return [form, error];
}

function openAddServerDialog() {
  openModal(
    h('h2', {}, 'Server hinzufügen'),
    h('h3', {}, 'Eigenen Server erstellen'),
    ...inlineForm({
      placeholder: 'Servername',
      button: 'Erstellen',
      onsubmit: async (name) => {
        const server = await api('/servers', { method: 'POST', body: { name } });
        closeModal();
        await loadServers();
        await selectView(server.id);
      },
    }),
    h('h3', {}, 'Mit Einladungscode beitreten'),
    ...inlineForm({
      placeholder: 'z. B. aB3dE6fG',
      button: 'Beitreten',
      onsubmit: async (code) => {
        const { serverId } = await api('/servers/join', { method: 'POST', body: { code } });
        closeModal();
        await loadServers();
        await selectView(serverId);
      },
    }),
    h('p', { className: 'muted small' }, 'Echten Discord-Servern trittst du über den Kompass „Entdecken“ bei.'),
  );
}

async function openDiscoverDialog() {
  openModal(h('h2', {}, 'Discord-Server entdecken'), h('p', { className: 'muted' }, 'Lade …'));
  try {
    const { servers, discord } = await api('/servers/discover');
    state.discord = discord;
    const status = !discord.enabled
      ? h('div', { className: 'callout' }, 'Die Discord-Brücke ist auf diesem Server nicht eingerichtet. Der Betreiber muss DISCORD_BOT_TOKEN setzen (siehe README).')
      : !discord.ready
        ? h('div', { className: 'callout' }, 'Die Verbindung zu Discord wird gerade aufgebaut …')
        : null;
    openModal(
      h('h2', {}, 'Discord-Server entdecken'),
      h('p', { className: 'muted', style: 'text-align: center' }, 'Diese echten Discord-Server sind mit Discord 2.0 verbunden. Tritt bei und chatte mit den Leuten dort.'),
      status,
      servers.length
        ? h(
            'div',
            { className: 'card-list', style: 'margin-top: 16px' },
            servers.map((server) =>
              h(
                'div',
                { className: 'card' },
                avatar({ avatar: server.iconUrl, username: server.name }, { large: true }),
                h('div', { className: 'name' }, h('strong', {}, server.name), h('span', { className: 'muted small' }, `${server.memberCount} Mitglieder aus Discord 2.0`)),
                server.joined
                  ? h('button', { className: 'secondary', onclick: () => { closeModal(); selectView(server.id); } }, 'Öffnen')
                  : h('button', { className: 'primary', onclick: () => joinBridged(server.id) }, 'Beitreten'),
              ),
            ),
          )
        : discord.ready && h('p', { className: 'muted', style: 'text-align: center' }, 'Noch keine Discord-Server verbunden.'),
      discord.inviteUrl &&
        h(
          'div',
          { className: 'callout' },
          h('strong', {}, 'Dein Discord-Server fehlt? '),
          'Lade den Brücken-Bot ein (du brauchst dort die Berechtigung „Server verwalten“): ',
          h('a', { href: discord.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Bot zu Discord hinzufügen'),
        ),
    );
  } catch (err) {
    openModal(h('h2', {}, 'Discord-Server entdecken'), h('p', { className: 'error' }, err.message));
  }
}

async function joinBridged(serverId) {
  try {
    await api('/servers/join', { method: 'POST', body: { serverId } });
    closeModal();
    await loadServers();
    await selectView(serverId);
  } catch (err) {
    toast(err.message, true);
  }
}

function openCreateChannelDialog() {
  openModal(
    h('h2', {}, 'Kanal erstellen'),
    ...inlineForm({
      placeholder: 'neuer-kanal',
      button: 'Erstellen',
      onsubmit: async (name) => {
        const channel = await api(`/servers/${state.view}/channels`, { method: 'POST', body: { name } });
        closeModal();
        await loadChannels();
        openChannel(state.channels.find((c) => c.id === channel.id));
      },
    }),
  );
}

function openNewDmDialog() {
  const results = h('div', { className: 'card-list' });
  const field = h('input', { placeholder: 'Benutzername oder Discord-Nutzer-ID', maxlength: 64 });
  let timer;
  let query = '';

  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });

  async function search() {
    query = field.value.trim();
    if (!query) return results.replaceChildren();
    const current = query;
    try {
      const { local, discord } = await api(`/users/search?q=${encodeURIComponent(current)}`);
      if (current !== query) return;
      const items = [
        ...local.map((user) =>
          h('div', { className: 'card' }, avatar(user), h('div', { className: 'name' }, h('strong', {}, user.username), h('span', { className: 'badge local' }, 'Discord 2.0')), h('button', { className: 'primary', onclick: () => startDm({ userId: user.id }) }, 'Schreiben')),
        ),
        ...discord.map((user) =>
          h(
            'div',
            { className: 'card' },
            avatar(user),
            h('div', { className: 'name' }, h('strong', {}, user.displayName), h('span', { className: 'muted small' }, `@${user.username} · ${user.guild} `), h('span', { className: 'badge discord' }, 'Discord')),
            h('button', { className: 'primary', onclick: () => startDm({ discordUserId: user.id }) }, 'Schreiben'),
          ),
        ),
      ];
      if (!items.length && /^\d{15,22}$/.test(current) && state.discord.ready) {
        items.push(
          h('div', { className: 'card' }, h('div', { className: 'name' }, h('strong', {}, `Discord-ID ${current}`), h('span', { className: 'muted small' }, 'Klappt nur, wenn ihr einen Server mit dem Bot teilt.')), h('button', { className: 'primary', onclick: () => startDm({ discordUserId: current }) }, 'Schreiben')),
        );
      }
      results.replaceChildren(...(items.length ? items : [h('p', { className: 'muted' }, 'Niemand gefunden.')]));
    } catch (err) {
      results.replaceChildren(h('p', { className: 'error' }, err.message));
    }
  }

  openModal(
    h('h2', {}, 'Neue Direktnachricht'),
    h('p', { className: 'muted', style: 'text-align: center' }, 'Schreib Leuten auf Discord 2.0 oder auf Discord.'),
    field,
    h('div', { style: 'margin-top: 12px' }, results),
    !state.discord.enabled && h('p', { className: 'muted small' }, 'Die Discord-Brücke ist nicht eingerichtet – du findest nur Nutzer von Discord 2.0.'),
  );
}

async function startDm(target) {
  try {
    const dm = await api('/dms', { method: 'POST', body: target });
    closeModal();
    await loadDms();
    if (state.view !== 'home') {
      state.view = 'home';
      $('#sidebar-title').textContent = 'Direktnachrichten';
      $('#sidebar-action').hidden = false;
      $('#members-toggle').hidden = true;
      $('#members').hidden = true;
      renderServers();
    }
    openChannel(state.dms.find((d) => d.id === dm.id) ?? dm);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Los geht's ----------

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.channel) {
    state.unread.delete(state.channel.id);
    renderSidebar();
  }
});

if (state.token) {
  start().catch(() => showAuth());
} else {
  showAuth();
}
