# Dialog persistence & application-restart recovery

This document describes how a drachtio-srf application can survive **its own restart** without
dropping live calls — the application persists its dialogs to an external store (e.g. redis),
and on restart rebuilds them and re-attaches to drachtio so in-dialog requests (re-INVITE, BYE)
keep routing to it.

> This is distinct from drachtio-server HA failover (the *server* restarting). That is handled
> automatically for inbound connections via reconnect + reattach. This document is about the
> *application* process restarting while the drachtio server stays up.

## Why the application has to do this

A live call is held together by two layers of state:

| Layer | Examples | Who can rebuild it |
|------|----------|--------------------|
| **SIP plumbing** | dialog id, call-id, tags, URIs, SDP, contact, route | drachtio (it owns the dialog + Sofia leg) |
| **Business state** | bridged B-leg, call variables, billing, IVR position, media handles | **only your app** |

When your app process restarts, its in-memory `Dialog` objects **and** business state are gone.
drachtio still holds the SIP dialog (it didn't restart), but the socket binding to your old
process expired. srf cannot invent your business state — so the app must persist what it needs
and rebuild on startup. srf gives you the machinery to do that with minimal code (approach B).

## How it works

1. You enable persistence with a store you provide (redis-backed, namespaced to this instance).
2. srf writes a **record** per dialog on creation, updates it on SDP change / metadata change,
   and deletes it on teardown.
3. On restart, you call `srf.recoverDialogs()`. srf reads the records, rebuilds each `Dialog`
   (SIP plumbing + your `metadata`), re-binds routing on drachtio via the `reattach` control
   verb, and emits `dialogRecovered` for each so you can re-wire your business logic.

Because only the app restarted, drachtio still has the dialog, so reattach succeeds immediately.
(If drachtio *also* restarted, run drachtio-server with HA/`--recover-on-start`; the two recover
independently and reattach retries until both are ready.)

**No drachtio-server changes are required** — this reuses the existing `reattach` verb.

## API

### `srf.enableDialogPersistence(store, [opts]) → Srf`

Registers a persistence backend. `store` must implement (sync or Promise-returning):

| Method | Purpose |
|--------|---------|
| `set(dialogId, record)` | persist / overwrite a dialog record |
| `del(dialogId)` | remove a dialog record |
| `list()` | return an array of **this instance's** dialog records |

`opts.recoverOnConnect` (boolean): automatically call `recoverDialogs()` on the next `connect`.

> **The store must namespace records to this application instance** (e.g. by an instance id) so
> `list()` returns only the dialogs this instance owns. If you run multiple app instances that
> share a drachtio connection, each must persist and recover only its own dialogs.

### `srf.recoverDialogs([socket]) → Promise<Dialog[]>`

Reads persisted records, rebuilds `Dialog` objects, re-attaches them, returns the recovered
dialogs. Call it once on startup (or use `recoverOnConnect`). Emits:

- `dialogRecovered(dialog)` — once per rebuilt dialog; restore your business logic here.
- `reattached({count, response})` / `reattach-failed(err)` — routing re-bind result.
- `recover-failed(err)` — a record could not be rebuilt.

### `dialog.metadata`

Opaque application business state attached to a dialog. Setting it re-persists the dialog.
Restored on recovery and available in the `dialogRecovered` handler.

```js
dialog.metadata = { bridgedTo: otherDlg.id, customerId, billingStarted: Date.now() };
```

### `dialog.toState()` / `Dialog.fromState(srf, record)` / `dialog.persist()`

Lower-level helpers. `toState()` is what gets persisted; `persist()` forces a re-save after you
mutate dialog state; `fromState()` is used internally by `recoverDialogs()`.

## What is persisted

`dialog.toState()` returns:

```js
{
  id,            // stack dialog id (the reattach key)
  type,          // 'uas' | 'uac'
  dialogType,    // 'INVITE' | 'SUBSCRIBE'
  subscribeEvent,
  sip:    { callId, localTag, remoteTag },
  local:  { uri, sdp, contact },
  remote: { uri, sdp },
  subscriptions,
  onHold,
  auth,          // if you supplied dialog auth
  metadata       // your opaque business state
}
```

srf re-persists automatically on dialog create, on successful `modify()` (SDP change), and when
you set `dialog.metadata`. Call `dialog.persist()` yourself after any other change you care about.

## Example: redis-backed store

srf intentionally has **no redis dependency** — you supply the store. A minimal `ioredis`-backed
implementation, namespaced per instance:

```js
const Redis = require('ioredis');
const Srf = require('drachtio-srf');

const redis = new Redis(process.env.REDIS_URL);
const INSTANCE = process.env.APP_INSTANCE_ID || require('os').hostname() + ':' + process.pid;
const KEY = (id) => `srf:dlg:${INSTANCE}:${id}`;
const IDX = `srf:dlg:${INSTANCE}`; // a set of this instance's dialog ids

const store = {
  async set(id, record) {
    await redis.multi().set(KEY(id), JSON.stringify(record)).sadd(IDX, id).exec();
  },
  async del(id) {
    await redis.multi().del(KEY(id)).srem(IDX, id).exec();
  },
  async list() {
    const ids = await redis.smembers(IDX);
    if (!ids.length) return [];
    const vals = await redis.mget(ids.map(KEY));
    return vals.filter(Boolean).map((v) => JSON.parse(v));
  }
};

const srf = new Srf();
srf.enableDialogPersistence(store);

srf.connect({ host: '10.0.0.100', port: 9022, secret: 'cymru' }); // the VIP if using HA

srf.on('connect', async () => {
  // rebuild dialogs that were live before this process restarted
  await srf.recoverDialogs();
});

srf.on('dialogRecovered', (dialog) => {
  // SIP plumbing is back; restore YOUR business logic from dialog.metadata
  const { bridgedTo } = dialog.metadata || {};
  dialog.on('destroy', () => cleanup(dialog));
  // re-establish timers, bridge references, etc.
});

// when you create a dialog, attach whatever you'll need after a restart
srf.invite(async (req, res) => {
  const uas = await srf.createUAS(req, res, { localSdp });
  uas.metadata = { customerId: req.get('X-Customer'), startedAt: Date.now() };
  uas.on('destroy', () => cleanup(uas));
});
```

> Use the same redis **server** for your records and (optionally) for drachtio's HA dialog store,
> but keep them in **separate keyspaces** (`srf:dlg:*` here vs drachtio's `ha:dialog:*`). The app
> persists its own records; it must not read drachtio's internal keys.

## Limitations

- **Business state is your responsibility.** srf rebuilds the SIP dialog and carries your
  `metadata`; it cannot reconstruct arbitrary in-memory state you did not put in `metadata`.
- **Instance ownership.** With multiple app instances, the store must scope records per instance;
  otherwise an instance could recover dialogs it does not own.
- **Media.** If your app fronts a media engine (rtpengine/FreeSWITCH), that media/session state
  must be made recoverable separately.
- **Inbound connections.** As with HA failover, recovery applies to inbound (`srf.connect()`)
  applications; outbound (`srf.listen()`) is not covered.
