// Relay: WebSocket client to the Worker's LiveSession Durable Object (docs/INTERFACE.md §4).
// Ground sends {type:'telemetry'|'state'|'event'}; everyone receives chat/presence/history.
// Auto-reconnects with backoff; telemetry sent while offline is queued (bounded) so an observer
// joining late still gets a complete profile via the DO's history replay.
//
// Mock mode (no Worker, ?sim=1): a scripted "Command Center" observer joins and answers, so the
// chat and presence UI can be exercised offline.

export class Relay extends EventTarget {
  constructor({ mock = false } = {}) {
    super();
    this.mock = mock;
    this.ws = null; this.url = null; this.connected = false;
    this.queue = []; this.sent = 0; this.errors = 0; this.backoff = 1000; this.closedByUser = false;
    this.presence = []; this.chat = [];
  }

  /** Build the WS url: relayUrl setting ('' = same origin) + /live/:ascentId. */
  static buildUrl(relayUrl, ascentId, token, role) {
    const base = relayUrl ? relayUrl.replace(/\/$/, '') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    return `${base}/live/${encodeURIComponent(ascentId)}?token=${encodeURIComponent(token || '')}&role=${encodeURIComponent(role || 'ground')}`;
  }

  connect(url) {
    this.url = url; this.closedByUser = false;
    if (this.mock) { this._mockConnect(); return; }
    this._open();
  }

  close() {
    this.closedByUser = true;
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this._setConnected(false);
  }

  send(obj) {
    if (this.mock) { this.sent++; return true; }
    if (this.connected && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); this.sent++; return true; } catch { this.errors++; }
    }
    if (obj.type === 'telemetry' || obj.type === 'event' || obj.type === 'chat') {
      this.queue.push(obj);
      if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);   // bounded memory
    }
    return false;
  }

  sendChat(text, user, role) {
    const msg = { type: 'chat', text, user, role, t: Date.now() };
    if (this.mock) { this._pushChat(msg); this._mockReply(text); return; }
    this.send(msg);
  }

  // ---- internals ---------------------------------------------------------------------------
  _open() {
    if (this.closedByUser) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.errors++; this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000; this._setConnected(true);
      const q = this.queue.splice(0); for (const m of q) this.send(m);
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } this._handle(m); };
    ws.onerror = () => { this.errors++; };
    ws.onclose = () => { this._setConnected(false); this.ws = null; this._retry(); };
  }
  _retry() {
    if (this.closedByUser) return;
    setTimeout(() => this._open(), this.backoff);
    this.backoff = Math.min(30000, this.backoff * 2);
  }
  _setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    this.dispatchEvent(new CustomEvent(v ? 'open' : 'close'));
  }
  _handle(m) {
    switch (m.type) {
      case 'chat': this._pushChat(m); break;
      case 'presence': this.presence = m.users || []; this.dispatchEvent(new CustomEvent('presence', { detail: this.presence })); break;
      case 'history': this.chat = m.chat || this.chat; this.dispatchEvent(new CustomEvent('history', { detail: m })); break;
      case 'telemetry': case 'state': case 'event': this.dispatchEvent(new CustomEvent(m.type, { detail: m })); break;
      case 'error': this.errors++; this.dispatchEvent(new CustomEvent('error', { detail: m })); break;
      default: break;
    }
  }
  _pushChat(m) {
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.dispatchEvent(new CustomEvent('chat', { detail: m }));
  }

  // ---- mock --------------------------------------------------------------------------------
  _mockConnect() {
    setTimeout(() => {
      this._setConnected(true);
      this.presence = [{ name: 'cc', fullName: 'Command Center', role: 'command', since: Date.now() }];
      this.dispatchEvent(new CustomEvent('presence', { detail: this.presence }));
      this._pushChat({ type: 'chat', user: 'cc', fullName: 'Command Center', role: 'command', text: 'Daten kommen sauber an. Wir lassen bis zum Cutdown steigen.', t: Date.now() });
    }, 2500);
    setTimeout(() => {
      this.presence.push({ name: 'crew1', fullName: 'Crew Bergung', role: 'ground', since: Date.now() });
      this.dispatchEvent(new CustomEvent('presence', { detail: this.presence }));
    }, 7000);
  }
  _mockReply(text) {
    const reply = /gelandet/i.test(text) ? 'Super, wir fahren los.' : /ausgel/i.test(text) ? 'Danke, Profil reicht uns.' : 'Verstanden.';
    setTimeout(() => this._pushChat({ type: 'chat', user: 'cc', fullName: 'Command Center', role: 'command', text: reply, t: Date.now() }), 1800);
  }
}
