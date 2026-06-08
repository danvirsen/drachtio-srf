require('should');
const net = require('net');
const Srf = require('../../lib/srf');
const Dialog = require('../../lib/dialog');

const PORT = 27044;

/*
 * A minimal mock drachtio server that speaks just enough of the wire protocol to validate the
 * application-restart recovery path end-to-end through the REAL WireProtocol / DrachtioAgent /
 * proto delegation: it answers `authenticate` and `reattach`, framing messages as `<len>#<payload>`.
 */
class MockDrachtio {
  constructor() {
    this.reattachIds = null;
    this._buf = Buffer.alloc(0);
  }
  listen() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this.socket = socket;
        socket.on('data', (d) => this._onData(socket, d));
        socket.on('error', () => {});
      });
      this.server.listen(PORT, () => resolve());
    });
  }
  _send(socket, payload) {
    socket.write(Buffer.byteLength(payload, 'utf8') + '#' + payload);
  }
  _onData(socket, data) {
    this._buf = Buffer.concat([this._buf, data]);
    let hash = this._buf.indexOf('#');
    while (hash > 0) {
      const len = parseInt(this._buf.toString('utf8', 0, hash), 10);
      const start = hash + 1;
      if (this._buf.length < start + len) return;
      const payload = this._buf.toString('utf8', start, start + len);
      this._buf = this._buf.subarray(start + len);
      this._handle(socket, payload);
      hash = this._buf.indexOf('#');
    }
  }
  _handle(socket, payload) {
    const t = payload.split('|');
    const msgId = t[0];
    const verb = t[1];
    if ('authenticate' === verb) {
      // <u>|response|<reqMsgId>|OK|<hostport>|<version>|<localhostports>
      this._send(socket, `srv1|response|${msgId}|OK|127.0.0.1:5060|v0.8.9|127.0.0.1:5060`);
    }
    else if ('reattach' === verb) {
      this.reattachIds = (t[2] || '').split(',').filter(Boolean);
      const n = this.reattachIds.length;
      this._send(socket, `srv2|response|${msgId}|OK|reattached ${n} of ${n}`);
    }
    // ignore ping/route/etc.
  }
  close() {
    return new Promise((resolve) => {
      try { if (this.socket) this.socket.destroy(); } catch (e) { /* noop */ }
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

function record(id) {
  return {
    id, type: 'uas', dialogType: 'INVITE', subscribeEvent: null,
    sip: { callId: `cid-${id}`, localTag: 'lt', remoteTag: 'rt' },
    local: { uri: 'sip:a@h', sdp: 'v=0', contact: '<sip:a@h>' },
    remote: { uri: 'sip:b@h', sdp: 'v=0' },
    subscriptions: [], onHold: false, metadata: { n: id }
  };
}

function memStore(seed) {
  const m = new Map(seed.map((r) => [r.id, r]));
  return {
    async set(id, rec) { m.set(id, rec); },
    async del(id) { m.delete(id); },
    async list() { return [...m.values()]; }
  };
}

describe('dialog recovery over the wire', function() {
  let mock, srf;

  afterEach(async function() {
    if (srf) { try { srf.disconnect(); } catch (e) { /* noop */ } srf = null; }
    if (mock) { await mock.close(); mock = null; }
  });

  it('on recoverDialogs(), sends reattach for persisted dialogs and emits reattached', async function() {
    mock = new MockDrachtio();
    await mock.listen();

    srf = new Srf();
    srf.enableDialogPersistence(memStore([record('dlg-1'), record('dlg-2')]));

    // wait for the real authenticated connection
    await new Promise((resolve, reject) => {
      srf.on('connect', resolve);
      srf.on('error', reject);
      srf.connect({ host: '127.0.0.1', port: PORT, secret: 'cymru' });
    });

    const reattached = new Promise((resolve) => srf.on('reattached', resolve));
    const recovered = await srf.recoverDialogs();
    const result = await reattached;

    recovered.length.should.equal(2);
    srf._dialogs.size.should.equal(2);
    result.count.should.equal(2);

    // the mock server actually received our reattach with both ids over the wire
    mock.reattachIds.sort().should.eql(['dlg-1', 'dlg-2']);

    // a recovered dialog can build an in-dialog request payload bound to the live socket
    const dlg = srf._dialogs.get('dlg-1');
    (dlg instanceof Dialog).should.be.true();
    dlg.socket.should.be.ok();
  });
});
