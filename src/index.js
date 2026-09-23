import { DurableObject } from 'cloudflare:workers';

const MAX_MESSAGES = 400;
const ADMIN_USERNAME = 'lcc-chat';
const ADMIN_PASSWORD = 'lcc-chat';

const normalizeUsername = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
const safeText = (value) => String(value || '').trim().slice(0, 2000);

async function digest(value) {
	const bytes = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class LccChat extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sessions = new Map();
		this.accounts = new Map();
		this.messages = [];
		this.ready = this.restore();
	}

	async restore() {
		const saved = await this.ctx.storage.get(['accounts', 'messages']);
		for (const account of saved.get('accounts') || []) this.accounts.set(account.username, account);
		this.messages = saved.get('messages') || [];
		if (!this.accounts.has(ADMIN_USERNAME)) this.accounts.set(ADMIN_USERNAME, { username: ADMIN_USERNAME, displayName: 'lcc-chat', passwordHash: await digest(ADMIN_PASSWORD), admin: true, temporary: false, tokens: [] });
		await this.save();
	}

	async save() {
		await this.ctx.storage.put({ accounts: [...this.accounts.values()], messages: this.messages });
	}


	async fetch() {
		await this.ready;
		const pair = new WebSocketPair();
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		this.sessions.set(server, null);
		server.send(JSON.stringify({ type: 'welcome' }));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws, raw) {
		await this.ready;
		let message;
		try { message = JSON.parse(raw); } catch { return; }
		if (message.type === 'auth') return this.authenticate(ws, message);
		if (message.type === 'resume') return this.resume(ws, message);
		const session = this.sessions.get(ws);
		if (!session) return this.send(ws, { type: 'error', message: 'Sign in first.' });
		if (message.type === 'message') return this.createMessage(ws, session, message);
		if (message.type === 'delete-message') return this.deleteMessage(ws, session, message);
		if (message.type === 'change-password') return this.changePassword(ws, session, message);
		if (message.type === 'admin-overview') return this.adminOverview(ws, session);
		if (message.type === 'signout') return this.signout(ws, session);
		if (message.type === 'call-invite') return this.callInvite(ws, session, message);
	}

	async authenticate(ws, message) {
		const username = normalizeUsername(message.username);
		const displayName = normalizeName(message.displayName) || username;
		const password = String(message.password || '');
		if (username.length < 2) return this.send(ws, { type: 'error', message: 'Choose a username with at least 2 letters or numbers.' });
		if (username === ADMIN_USERNAME) {
			if (password !== ADMIN_PASSWORD) return this.send(ws, { type: 'error', message: 'That username or password is not correct.' });
			const admin = this.accounts.get(ADMIN_USERNAME);
			return this.beginSession(ws, admin, await this.createSessionToken(admin));
		}
		const account = this.accounts.get(username);
		if (account) {
			if (account.temporary) return this.send(ws, { type: 'error', message: 'Temporary accounts cannot be signed into again after signing out.' });
			if (account.passwordHash !== (password ? await digest(password) : '')) return this.send(ws, { type: 'error', message: 'That username or password is not correct.' });
			account.displayName = displayName;
			this.accounts.set(username, account);
			await this.save();
			return this.beginSession(ws, account, await this.createSessionToken(account));
		}
		const temporary = !password;
		const newAccount = { username, displayName, passwordHash: temporary ? '' : await digest(password), temporary, tokens: [] };
		this.accounts.set(username, newAccount);
		await this.save();
		return this.beginSession(ws, newAccount, await this.createSessionToken(newAccount));
	}

	async createSessionToken(account) {
		const token = crypto.randomUUID();
		account.tokens = [...(account.tokens || []), token].slice(-8);
		this.accounts.set(account.username, account);
		await this.save();
		return token;
	}

	resume(ws, message) {
		const token = String(message.token || '');
		for (const account of this.accounts.values()) {
			if ((account.tokens || []).includes(token)) return this.beginSession(ws, account, token);
		}
		this.send(ws, { type: 'signed-out' });
	}

	async signout(ws, session) {
		const account = this.accounts.get(session.username);
		if (account) {
			account.tokens = (account.tokens || []).filter((token) => token !== session.token);
			this.accounts.set(account.username, account);
			await this.save();
		}
		this.sessions.set(ws, null);
		this.send(ws, { type: 'signed-out' });
		this.broadcast({ type: 'presence', users: this.onlineUsers() });
	}

	beginSession(ws, account, token = '') {
		const session = { username: account.username, displayName: account.displayName, admin: Boolean(account.admin), temporary: account.temporary, token };
		this.sessions.set(ws, session);
		this.send(ws, { type: 'authenticated', user: session, token, messages: this.visibleMessages(session), directory: this.directory() });
		this.broadcast({ type: 'presence', users: this.onlineUsers() });
	}

	visibleMessages(session) {
		return this.messages.filter((message) => message.channel === 'central' || message.sender === session.username || message.recipient === session.username || session.admin);
	}

	async createMessage(ws, session, incoming) {
		const text = safeText(incoming.text);
		const attachment = typeof incoming.attachment === 'object' && typeof incoming.attachment.data === 'string' && incoming.attachment.data.startsWith('data:') && incoming.attachment.data.length <= 1500000 ? { name: safeText(incoming.attachment.name).slice(0, 120), type: safeText(incoming.attachment.type).slice(0, 100), data: incoming.attachment.data } : null;
		const target = incoming.channel === 'dm' ? normalizeUsername(incoming.recipient) : null;
		if (!text && !attachment) return;
		if (incoming.channel === 'dm' && (!target || target === session.username)) return this.send(ws, { type: 'error', message: 'Enter another valid username to send a direct message.' });
		const message = { id: crypto.randomUUID(), channel: target ? 'dm' : 'central', recipient: target, sender: session.username, senderName: session.displayName, text, attachment, createdAt: Date.now() };
		this.messages.push(message);
		this.messages = this.messages.slice(-MAX_MESSAGES);
		await this.save();
		this.broadcastMessage(message);
	}


	callInvite(ws, session, incoming) {
		const recipient = normalizeUsername(incoming.recipient);
		if (!recipient || recipient === session.username) return;
		const room = safeText(incoming.room).slice(0, 80);
		for (const [peer, target] of this.sessions) if (target?.username === recipient) this.send(peer, { type: 'call-invite', from: session.username, fromName: session.displayName, room });
	}

	async deleteMessage(ws, session, incoming) {
		const index = this.messages.findIndex((message) => message.id === incoming.id);
		if (index < 0) return;
		const message = this.messages[index];
		if (!session.admin && message.sender !== session.username) return this.send(ws, { type: 'error', message: 'You can only delete your own messages.' });
		this.messages.splice(index, 1);
		await this.save();
		this.broadcast({ type: 'message-deleted', id: incoming.id });
	}

	async changePassword(ws, session, incoming) {
		if (!session.admin) return this.send(ws, { type: 'error', message: 'Only the lcc-chat administrator can change passwords.' });
		const username = normalizeUsername(incoming.username);
		const password = String(incoming.password || '');
		const account = this.accounts.get(username);
		if (!account || !password) return this.send(ws, { type: 'error', message: 'Choose an existing user and a new password.' });
		account.passwordHash = await digest(password);
		account.temporary = false;
		account.expiresAt = null;
		this.accounts.set(username, account);
		await this.save();
		this.send(ws, { type: 'notice', message: `Password updated for @${username}.` });
	}

	adminOverview(ws, session) {
		if (!session.admin) return;
		this.send(ws, { type: 'admin-overview', accounts: [...this.accounts.values()].map(({ username, displayName, temporary, expiresAt }) => ({ username, displayName, temporary, expiresAt })), messages: this.messages.length });
	}

	directory() {
		return [...this.accounts.values()].filter((account) => !account.admin).map(({ username, displayName }) => ({ username, displayName })).sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	onlineUsers() {
		const users = new Map();
		for (const session of this.sessions.values()) if (session) users.set(session.username, { username: session.username, displayName: session.displayName, admin: session.admin });
		return [...users.values()];
	}

	broadcastMessage(message) {
		for (const [ws, session] of this.sessions) {
			if (session && (message.channel === 'central' || session.admin || session.username === message.sender || session.username === message.recipient)) this.send(ws, { type: 'message', message });
		}
	}

	broadcast(payload) { for (const ws of this.sessions.keys()) this.send(ws, payload); }
	send(ws, payload) { try { ws.send(JSON.stringify(payload)); } catch {} }
	webSocketClose(ws) { this.sessions.delete(ws); this.broadcast({ type: 'presence', users: this.onlineUsers() }); }
	webSocketError(ws) { this.webSocketClose(ws); }
}


export class CentralCall extends DurableObject {
	constructor(ctx, env) { super(ctx, env); this.sessions = new Map(); }
	fetch() {
		const pair = new WebSocketPair();
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		const id = crypto.randomUUID();
		const peers = [...this.sessions.values()].map((session) => session.id);
		this.sessions.set(server, { id });
		server.send(JSON.stringify({ type: 'ready', id, peers }));
		this.relay({ type: 'joined', from: id }, id);
		this.relay({ type: 'room', count: this.sessions.size }, null);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	webSocketMessage(ws, raw) {
		const session = this.sessions.get(ws);
		if (!session) return;
		try { const message = JSON.parse(raw); this.relay({ ...message, from: session.id }, session.id, message.to); } catch {}
	}
	relay(message, from, to) { for (const [ws, session] of this.sessions) if (session.id !== from && (!to || session.id === to)) try { ws.send(JSON.stringify(message)); } catch {} }
	webSocketClose(ws) { const session = this.sessions.get(ws); if (!session) return; this.sessions.delete(ws); this.relay({ type: 'left', from: session.id }, session.id); this.relay({ type: 'room', count: this.sessions.size }, null); }
	webSocketError(ws) { this.webSocketClose(ws); }
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === '/api/ws') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
			return env.LCC_CHAT.get(env.LCC_CHAT.idFromName('global')).fetch(request);
		}
		if (pathname.startsWith('/ws/')) {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
			return env.CENTRAL_CALL.get(env.CENTRAL_CALL.idFromName(pathname.slice(4))).fetch(request);
		}
		if (pathname === '/ice') return Response.json({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
		return env.ASSETS.fetch(request);
	},
};
