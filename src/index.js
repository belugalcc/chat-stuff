import { DurableObject } from 'cloudflare:workers';

const TEMP_ACCOUNT_TTL = 24 * 60 * 60 * 1000;
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
		await this.purgeTemporaryAccounts();
	}

	async save() {
		await this.ctx.storage.put({ accounts: [...this.accounts.values()], messages: this.messages });
	}

	async purgeTemporaryAccounts() {
		const now = Date.now();
		let changed = false;
		for (const [username, account] of this.accounts) {
			if (account.temporary && account.expiresAt <= now) {
				this.accounts.delete(username);
				changed = true;
			}
		}
		if (changed) await this.save();
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
		const session = this.sessions.get(ws);
		if (!session) return this.send(ws, { type: 'error', message: 'Sign in first.' });
		if (message.type === 'message') return this.createMessage(ws, session, message);
		if (message.type === 'delete-message') return this.deleteMessage(ws, session, message);
		if (message.type === 'change-password') return this.changePassword(ws, session, message);
		if (message.type === 'admin-overview') return this.adminOverview(ws, session);
	}

	async authenticate(ws, message) {
		const username = normalizeUsername(message.username);
		const displayName = normalizeName(message.displayName) || username;
		const password = String(message.password || '');
		if (username.length < 2) return this.send(ws, { type: 'error', message: 'Choose a username with at least 2 letters or numbers.' });
		if (username === ADMIN_USERNAME) {
			if (password !== ADMIN_PASSWORD) return this.send(ws, { type: 'error', message: 'That username or password is not correct.' });
			return this.beginSession(ws, { username, displayName: 'lcc-chat', admin: true, temporary: false });
		}
		await this.purgeTemporaryAccounts();
		const account = this.accounts.get(username);
		if (account) {
			if (account.passwordHash !== (password ? await digest(password) : '')) return this.send(ws, { type: 'error', message: 'That username or password is not correct.' });
			account.displayName = displayName;
			this.accounts.set(username, account);
			await this.save();
			return this.beginSession(ws, account);
		}
		const temporary = !password;
		const newAccount = { username, displayName, passwordHash: temporary ? '' : await digest(password), temporary, expiresAt: temporary ? Date.now() + TEMP_ACCOUNT_TTL : null };
		this.accounts.set(username, newAccount);
		await this.save();
		return this.beginSession(ws, newAccount);
	}

	beginSession(ws, account) {
		const session = { username: account.username, displayName: account.displayName, admin: Boolean(account.admin), temporary: account.temporary };
		this.sessions.set(ws, session);
		this.send(ws, { type: 'authenticated', user: session, messages: this.visibleMessages(session), users: this.onlineUsers() });
		this.broadcast({ type: 'presence', users: this.onlineUsers() });
	}

	visibleMessages(session) {
		return this.messages.filter((message) => message.channel === 'central' || message.sender === session.username || message.recipient === session.username || session.admin);
	}

	async createMessage(ws, session, incoming) {
		const text = safeText(incoming.text);
		const target = incoming.channel === 'dm' ? normalizeUsername(incoming.recipient) : null;
		if (!text) return;
		if (incoming.channel === 'dm' && (!target || target === session.username)) return this.send(ws, { type: 'error', message: 'Enter another valid username to send a direct message.' });
		const message = { id: crypto.randomUUID(), channel: target ? 'dm' : 'central', recipient: target, sender: session.username, senderName: session.displayName, text, createdAt: Date.now() };
		this.messages.push(message);
		this.messages = this.messages.slice(-MAX_MESSAGES);
		await this.save();
		this.broadcastMessage(message);
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
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	webSocketMessage(ws, raw) {
		const session = this.sessions.get(ws);
		if (!session) return;
		try { const message = JSON.parse(raw); this.relay({ ...message, from: session.id }, session.id, message.to); } catch {}
	}
	relay(message, from, to) { for (const [ws, session] of this.sessions) if (session.id !== from && (!to || session.id === to)) try { ws.send(JSON.stringify(message)); } catch {} }
	webSocketClose(ws) { const session = this.sessions.get(ws); if (!session) return; this.sessions.delete(ws); this.relay({ type: 'left', from: session.id }, session.id); }
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
