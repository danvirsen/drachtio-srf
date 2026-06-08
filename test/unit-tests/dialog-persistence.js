require('should');
const Srf = require('../../lib/srf');
const Dialog = require('../../lib/dialog');

function sampleRecord(id = 'dlg-1') {
  return {
    id,
    type: 'uas',
    dialogType: 'INVITE',
    subscribeEvent: null,
    sip: { callId: 'call-1', localTag: 'lt', remoteTag: 'rt' },
    local: { uri: 'sip:a@host', sdp: 'v=0-local', contact: '<sip:a@host>' },
    remote: { uri: 'sip:b@host', sdp: 'v=0-remote' },
    subscriptions: [],
    onHold: false,
    metadata: { customerId: 42 }
  };
}

function memStore() {
  const m = new Map();
  return {
    calls: { set: 0, del: 0, list: 0 },
    async set(id, rec) { this.calls.set++; m.set(id, rec); },
    async del(id) { this.calls.del++; m.delete(id); },
    async list() { this.calls.list++; return [...m.values()]; },
    _map: m
  };
}

describe('dialog persistence (approach B)', function() {

  describe('Dialog.toState / fromState', function() {
    it('rebuilds a dialog from a record and round-trips toState()', function() {
      const srf = new Srf();
      const rec = sampleRecord();
      const dlg = Dialog.fromState(srf, rec);

      dlg.id.should.equal('dlg-1');
      dlg.type.should.equal('uas');
      dlg.dialogType.should.equal('INVITE');
      dlg.sip.callId.should.equal('call-1');
      dlg.local.sdp.should.equal(rec.local.sdp);
      dlg.remote.sdp.should.equal(rec.remote.sdp);
      dlg.metadata.should.eql({ customerId: 42 });
      dlg.connected.should.be.true();

      const state = dlg.toState();
      state.should.have.properties(['id', 'type', 'dialogType', 'sip', 'local', 'remote', 'metadata']);
      state.id.should.equal('dlg-1');
      state.metadata.should.eql({ customerId: 42 });
    });

    it('exposes id/dialogType/socket without a live req/res', function() {
      const srf = new Srf();
      const dlg = Dialog.fromState(srf, sampleRecord());
      const fakeSocket = { id: 'sock' };

      dlg.setSocket(fakeSocket);
      dlg.socket.should.equal(fakeSocket);
      (() => dlg.id).should.not.throw();
      (() => dlg.dialogType).should.not.throw();
      (() => dlg.subscribeEvent).should.not.throw();
    });

    it('re-persists when metadata is set', function(done) {
      const srf = new Srf();
      const store = memStore();
      srf.enableDialogPersistence(store);
      const dlg = Dialog.fromState(srf, sampleRecord());

      dlg.metadata = { foo: 'bar' };
      setImmediate(() => {
        store.calls.set.should.be.greaterThan(0);
        store._map.get('dlg-1').metadata.should.eql({ foo: 'bar' });
        done();
      });
    });
  });

  describe('enableDialogPersistence', function() {
    it('requires a store implementing set/del/list', function() {
      const srf = new Srf();
      (() => srf.enableDialogPersistence({})).should.throw();
      (() => srf.enableDialogPersistence({ set() {}, del() {} })).should.throw();
      (() => srf.enableDialogPersistence({ set() {}, del() {}, list() {} })).should.not.throw();
    });
  });

  describe('add/remove dialog hooks', function() {
    it('persists on addDialog and deletes on removeDialog', function(done) {
      const srf = new Srf();
      const store = memStore();
      srf.enableDialogPersistence(store);
      const dlg = Dialog.fromState(srf, sampleRecord());

      srf.addDialog(dlg);
      setImmediate(() => {
        store._map.has('dlg-1').should.be.true();
        srf.removeDialog(dlg);
        setImmediate(() => {
          store._map.has('dlg-1').should.be.false();
          done();
        });
      });
    });
  });

  describe('recoverDialogs', function() {
    it('rebuilds dialogs, emits dialogRecovered, and reattaches them', async function() {
      const srf = new Srf();
      const store = memStore();
      await store.set('dlg-1', sampleRecord('dlg-1'));
      await store.set('dlg-2', sampleRecord('dlg-2'));
      srf.enableDialogPersistence(store);

      // stub the agent control plane (no real connection in a pure unit test)
      const fakeSocket = { id: 'sock' };
      const reattachCalls = [];
      srf._app._getDefaultSocket = () => fakeSocket;
      srf._app.reattach = (socket, ids, cb) => {
        reattachCalls.push({ socket, ids });
        cb(null, { response: `reattached ${ids.length} of ${ids.length}` });
      };

      const recoveredIds = [];
      srf.on('dialogRecovered', (d) => recoveredIds.push(d.id));

      const recovered = await srf.recoverDialogs();

      recovered.length.should.equal(2);
      recoveredIds.sort().should.eql(['dlg-1', 'dlg-2']);
      srf._dialogs.size.should.equal(2);
      srf._dialogs.get('dlg-1').metadata.should.eql({ customerId: 42 });

      reattachCalls.length.should.be.greaterThan(0);
      reattachCalls[0].ids.sort().should.eql(['dlg-1', 'dlg-2']);
      reattachCalls[0].socket.should.equal(fakeSocket);

      // recovered dialogs must point at the (new) socket so in-dialog requests go out on it
      srf._dialogs.get('dlg-1').socket.should.equal(fakeSocket);
    });

    it('throws if persistence was not enabled', function() {
      const srf = new Srf();
      return srf.recoverDialogs().then(
        () => { throw new Error('should have rejected'); },
        (err) => { err.message.should.match(/enableDialogPersistence/); }
      );
    });
  });
});
