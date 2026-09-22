const $ = (selector) => document.querySelector(selector);
const state = { user: null, users: [], messages: [], channel: 'central', dm: null, ws: null };
const onboarding = $('#onboarding');
const app = $('#app');
const toast = $('#toast');
const send = (payload) => state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify(payload));
const notice = (message) => { toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2800); };
const escape = (value) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function connect() {
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	state.ws = new WebSocket(`${protocol}//${location.host}/api/ws`);
	state.ws.addEventListener('message', ({ data }) => handle(JSON.parse(data)));
	state.ws.addEventListener('close', () => state.user && notice('Connection lost. Refresh to reconnect.'));
}

function handle(data) {
	if (data.type === 'error') return state.user ? notice(data.message) : ($('#auth-error').textContent = data.message);
	if (data.type === 'authenticated') {
		state.user = data.user; state.users = data.users; state.messages = data.messages;
		localStorage.setItem('lcc-chat-user', JSON.stringify(state.user));
		onboarding.hidden = true; app.hidden = false; render(); return;
	}
	if (data.type === 'presence') { state.users = data.users; renderMembers(); return; }
	if (data.type === 'message') { state.messages.push(data.message); renderMessages(); return; }
	if (data.type === 'message-deleted') { state.messages = state.messages.filter((message) => message.id !== data.id); renderMessages(); return; }
	if (data.type === 'notice') return notice(data.message);
	if (data.type === 'admin-overview') renderAdmin(data);
}

function render() { $('#me-name').textContent = state.user.displayName; $('#me-tag').textContent = `@${state.user.username}`; $('#me-avatar').textContent = state.user.displayName.slice(0, 1).toUpperCase(); $('#admin-button').hidden = !state.user.admin; renderMembers(); renderDmList(); renderChannel(); renderMessages(); }
function renderMembers() { $('#online-count').textContent = `${state.users.length} online`; $('#member-count').textContent = state.users.length; $('#member-list').innerHTML = state.users.map((user) => `<button class="member" data-user="${escape(user.username)}"><span class="avatar">${escape(user.displayName.slice(0, 1).toUpperCase())}</span><span>${escape(user.displayName)}${user.admin ? '<em> ADMIN</em>' : ''}<small>@${escape(user.username)}</small></span></button>`).join(''); document.querySelectorAll('.member').forEach((button) => button.onclick = () => openDm(button.dataset.user)); }
function renderDmList() { const partners = [...new Set(state.messages.filter((message) => message.channel === 'dm' && (message.sender === state.user.username || message.recipient === state.user.username)).map((message) => message.sender === state.user.username ? message.recipient : message.sender))]; $('#dm-list').innerHTML = partners.map((username) => `<button class="dm ${state.dm === username ? 'selected' : ''}" data-user="${escape(username)}">@ ${escape(username)}</button>`).join(''); document.querySelectorAll('.dm').forEach((button) => button.onclick = () => openDm(button.dataset.user)); }
function renderChannel() { const isDm = state.channel === 'dm'; $('#header-icon').textContent = isDm ? '@' : state.channel === 'call' ? '◉' : '#'; $('#channel-title').textContent = isDm ? state.dm : state.channel === 'call' ? 'central-call' : 'central-chat'; $('#channel-subtitle').textContent = isDm ? `Direct messages with @${state.dm}` : state.channel === 'call' ? 'Join the community call room' : 'Everyone in lcc-chat can talk here'; $('#message-input').placeholder = isDm ? `Message @${state.dm}` : state.channel === 'call' ? 'Central call chat is coming next' : 'Message #central-chat'; $('#composer').hidden = state.channel === 'call'; document.querySelectorAll('.channel').forEach((button) => button.classList.toggle('selected', button.dataset.channel === state.channel)); }
function renderMessages() { const visible = state.messages.filter((message) => state.channel === 'central' ? message.channel === 'central' : state.channel === 'dm' ? message.channel === 'dm' && (message.sender === state.dm || message.recipient === state.dm) : false); $('#messages').innerHTML = state.channel === 'call' ? '<div class="call-panel"><div class="call-orb">◉</div><h2>central-call</h2><p>A single community call room for everyone is ready to become the center of your server.</p><a class="primary call-link" href="/call?i=lcc-central">Join central call</a></div>' : visible.map((message) => `<article class="message"><div class="avatar">${escape(message.senderName.slice(0, 1).toUpperCase())}</div><div><strong>${escape(message.senderName)}</strong><span class="tag">@${escape(message.sender)}</span><time>${new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><p>${escape(message.text).replace(/\n/g, '<br>')}</p></div>${(state.user.admin || message.sender === state.user.username) ? `<button class="delete" data-id="${message.id}" title="Delete message">×</button>` : ''}</article>`).join('') || '<div class="empty">No messages here yet. Say hello.</div>'; document.querySelectorAll('.delete').forEach((button) => button.onclick = () => send({ type: 'delete-message', id: button.dataset.id })); $('#messages').scrollTop = $('#messages').scrollHeight; }
function openDm(username) { if (username === state.user.username) return; state.channel = 'dm'; state.dm = username; renderDmList(); renderChannel(); renderMessages(); }

$('#auth-form').addEventListener('submit', (event) => { event.preventDefault(); $('#auth-error').textContent = ''; send({ type: 'auth', displayName: $('#display-name').value, username: $('#username').value, password: $('#password').value }); });
$('#composer').addEventListener('submit', (event) => { event.preventDefault(); const text = $('#message-input').value; if (!text.trim()) return; send({ type: 'message', channel: state.channel, recipient: state.dm, text }); $('#message-input').value = ''; });
$('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#new-dm').onclick = () => $('#dm-form').hidden = !$('#dm-form').hidden;
$('#dm-form').addEventListener('submit', (event) => { event.preventDefault(); const user = $('#dm-username').value.trim().toLowerCase(); if (user) { openDm(user); $('#dm-username').value = ''; $('#dm-form').hidden = true; } });
document.querySelectorAll('.channel').forEach((button) => button.onclick = () => { state.channel = button.dataset.channel; state.dm = null; renderChannel(); renderMessages(); });
$('#logout').onclick = () => { localStorage.removeItem('lcc-chat-user'); location.reload(); };
$('#admin-button').onclick = () => { $('#admin-dialog').showModal(); send({ type: 'admin-overview' }); };
$('#update-password').onclick = (event) => { event.preventDefault(); send({ type: 'change-password', username: $('#admin-user').value, password: $('#admin-password').value }); $('#admin-password').value = ''; };
function renderAdmin(data) { $('#admin-summary').textContent = `${data.accounts.length} registered accounts · ${data.messages} stored messages`; $('#account-list').innerHTML = data.accounts.map((account) => `<div class="account"><strong>${escape(account.displayName)}</strong><span>@${escape(account.username)} ${account.temporary ? '· temporary' : ''}</span></div>`).join(''); }
connect();
