const $ = (selector) => document.querySelector(selector);
let pendingAttachment = null;
const state = { user: null, directory: [], messages: [], channel: 'central', dm: null, ws: null, step: 1 };
const steps = [{ title: 'What is your username?', copy: 'This is how friends will find and direct message you.' }, { title: 'How should people see you?', copy: 'Choose a display name for the community.' }, { title: 'Keep this account?', copy: 'A password lets you sign in from any device.' }];
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
	state.ws.addEventListener('open', () => { const token = localStorage.getItem('lcc-chat-session'); if (token) send({ type: 'resume', token }); });
}

function handle(data) {
	if (data.type === 'error') return state.user ? notice(data.message) : ($('#auth-error').textContent = data.message);
	if (data.type === 'authenticated') {
		state.user = data.user; state.directory = data.directory; state.messages = data.messages;
		if (data.token) localStorage.setItem('lcc-chat-session', data.token);
		localStorage.setItem('lcc-chat-user', JSON.stringify(state.user));
		onboarding.hidden = true; app.hidden = false; render(); return;
	}
	if (data.type === 'signed-out') { localStorage.removeItem('lcc-chat-session'); localStorage.removeItem('lcc-chat-user'); state.user = null; onboarding.hidden = false; app.hidden = false; setStep(1); return; }
	if (data.type === 'message') { state.messages.push(data.message); if (data.message.sender !== state.user.username && (state.channel !== data.message.channel || (data.message.channel === 'dm' && state.dm !== data.message.sender))) alertUser(`New message from ${data.message.senderName}`, data.message.text || 'Shared an attachment'); renderMessages(); return; }
	if (data.type === 'call-invite') { const url = `/call?i=${encodeURIComponent(data.room)}&chat=dm&user=${encodeURIComponent(data.from)}`; alertUser(`${data.fromName} is calling you`, 'Tap to join the private call', url); return; }
	if (data.type === 'message-deleted') { state.messages = state.messages.filter((message) => message.id !== data.id); renderMessages(); return; }
	if (data.type === 'notice') return notice(data.message);
	if (data.type === 'admin-overview') renderAdmin(data);
}

function alertUser(title, body, url = '') { notice(title); if ('Notification' in window && Notification.permission === 'granted') { const notification = new Notification(title, { body }); if (url) notification.onclick = () => { window.focus(); location.href = url; }; } }
function render() { $('#me-name').textContent = state.user.displayName; $('#me-tag').textContent = `@${state.user.username}`; $('#me-avatar').textContent = state.user.displayName.slice(0, 1).toUpperCase(); $('#admin-button').hidden = !state.user.admin; renderDirectory(); renderDmList(); renderChannel(); renderMessages(); }
function renderDirectory() { const select = $('#dm-username'); select.innerHTML = '<option value="">Choose a person</option>' + state.directory.filter((person) => person.username !== state.user.username).map((person) => `<option value="${escape(person.username)}">${escape(person.displayName)} (@${escape(person.username)})</option>`).join(''); }
function renderDmList() { const partners = [...new Set(state.messages.filter((message) => message.channel === 'dm' && (message.sender === state.user.username || message.recipient === state.user.username)).map((message) => message.sender === state.user.username ? message.recipient : message.sender))]; $('#dm-list').innerHTML = partners.map((username) => `<button class="dm ${state.dm === username ? 'selected' : ''}" data-user="${escape(username)}">@ ${escape(username)}</button>`).join(''); document.querySelectorAll('.dm').forEach((button) => button.onclick = () => openDm(button.dataset.user)); }
function renderChannel() { const isDm = state.channel === 'dm'; const call = $('#call-dm'); call.hidden = !isDm; if (isDm) call.href = `/call?i=dm-${[state.user.username, state.dm].sort().map(encodeURIComponent).join('-')}&chat=dm&user=${encodeURIComponent(state.dm)}`; $('#header-icon').textContent = isDm ? '@' : state.channel === 'call' ? '◉' : '#'; $('#channel-title').textContent = isDm ? state.dm : state.channel === 'call' ? 'central-call' : 'central-chat'; $('#channel-subtitle').textContent = isDm ? `Direct messages with @${state.dm}` : state.channel === 'call' ? 'Join the community call room' : 'Everyone in lcc-chat can talk here'; $('#message-input').placeholder = isDm ? `Message @${state.dm}` : state.channel === 'call' ? 'Central call chat is coming next' : 'Message #central-chat'; $('#composer').hidden = state.channel === 'call'; document.querySelectorAll('.channel').forEach((button) => button.classList.toggle('selected', button.dataset.channel === state.channel)); }
function renderMessages() { const visible = state.messages.filter((message) => state.channel === 'central' ? message.channel === 'central' : state.channel === 'dm' ? message.channel === 'dm' && (message.sender === state.dm || message.recipient === state.dm) : false); $('#messages').innerHTML = state.channel === 'call' ? `<div class="call-panel"><div class="call-orb">◉</div><h2>${state.dm ? `Call @${escape(state.dm)}` : 'central-call'}</h2><p>${state.dm ? 'Start a direct call with this conversation.' : 'A single community call room for everyone.'}</p><a class="primary call-link" href="/call?i=${state.dm ? `dm-${[state.user.username, state.dm].sort().map(encodeURIComponent).join('-')}` : 'lcc-central'}&chat=${state.dm ? `dm&user=${encodeURIComponent(state.dm)}` : 'central'}">Join call</a></div>` : visible.map((message) => `<article class="message"><div class="avatar">${escape(message.senderName.slice(0, 1).toUpperCase())}</div><div><strong>${escape(message.senderName)}</strong><span class="tag">@${escape(message.sender)}</span><time>${new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><p>${escape(message.text).replace(/\n/g, '<br>')}</p>${message.attachment ? (message.attachment.type.startsWith('image/') ? `<img class="attachment" src="${message.attachment.data}" alt="${escape(message.attachment.name)}" />` : `<a class="attachment-file" href="${message.attachment.data}" download="${escape(message.attachment.name)}">${escape(message.attachment.name || 'Download shared file')}</a>`) : ''}</div>${(state.user.admin || message.sender === state.user.username) ? `<button class="delete" data-id="${message.id}" title="Delete message">×</button>` : ''}</article>`).join('') || '<div class="empty">No messages here yet. Say hello.</div>'; document.querySelectorAll('.delete').forEach((button) => button.onclick = () => send({ type: 'delete-message', id: button.dataset.id })); $('#messages').scrollTop = $('#messages').scrollHeight; }
function openDm(username) { if (username === state.user.username) return; state.channel = 'dm'; state.dm = username; renderDmList(); renderChannel(); renderMessages(); }

function setStep(step) { state.step = step; const detail = steps[step - 1]; $('#step-count').textContent = `STEP ${step} OF 3`; $('#step-title').textContent = detail.title; $('#step-copy').textContent = detail.copy; document.querySelectorAll('.auth-step').forEach((field) => field.hidden = Number(field.dataset.step) !== step); $('#temporary-note').hidden = step !== 3; $('#back-step').hidden = step === 1; $('#next-step').textContent = step === 3 ? 'Enter lcc-chat' : 'Next'; document.querySelector(`.auth-step[data-step="${step}"] input`).focus(); }
$('#auth-form').addEventListener('submit', (event) => { event.preventDefault(); $('#auth-error').textContent = ''; if (state.step < 3) return setStep(state.step + 1); send({ type: 'auth', displayName: $('#display-name').value, username: $('#username').value, password: $('#password').value }); });
$('#back-step').onclick = () => setStep(Math.max(1, state.step - 1));
$('#composer').addEventListener('submit', (event) => { event.preventDefault(); const text = $('#message-input').value; if (!text.trim() && !pendingAttachment) return; send({ type: 'message', channel: state.channel, recipient: state.dm, text, attachment: pendingAttachment }); pendingAttachment = null; $('#file-input').value = ''; $('#message-input').value = ''; });
$('#file-input').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 1000000) return notice('Files must be smaller than 1 MB.'); const reader = new FileReader(); reader.onload = () => { pendingAttachment = { name: file.name, type: file.type, data: reader.result }; notice(`${file.name} ready to send`); }; reader.readAsDataURL(file); });
$('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#new-dm').onclick = () => $('#dm-form').hidden = !$('#dm-form').hidden;
$('#dm-form').addEventListener('submit', (event) => { event.preventDefault(); const user = $('#dm-username').value; if (user) { openDm(user); $('#dm-username').value = ''; $('#dm-form').hidden = true; } });
document.querySelectorAll('.channel').forEach((button) => button.onclick = () => { state.channel = button.dataset.channel; state.dm = null; renderChannel(); renderMessages(); });
$('#call-dm').addEventListener('click', () => { if (state.dm) send({ type: 'call-invite', recipient: state.dm, room: `dm-${[state.user.username, state.dm].sort().join('-')}` }); });
$('#logout').onclick = () => send({ type: 'signout' });
$('#admin-button').onclick = () => { $('#admin-dialog').showModal(); send({ type: 'admin-overview' }); };
$('#update-password').onclick = (event) => { event.preventDefault(); send({ type: 'change-password', username: $('#admin-user').value, password: $('#admin-password').value }); $('#admin-password').value = ''; };
function renderAdmin(data) { $('#admin-summary').textContent = `${data.accounts.length} registered accounts · ${data.messages} stored messages`; $('#account-list').innerHTML = data.accounts.map((account) => `<div class="account"><strong>${escape(account.displayName)}</strong><span>@${escape(account.username)} ${account.temporary ? '· temporary' : ''}</span></div>`).join(''); }
app.hidden = false; setStep(1); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); connect();
