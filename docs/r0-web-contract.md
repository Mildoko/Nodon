# R0 Web / Node / Canvas contract

## Scope and ownership

This is the T04 local controlled validation adapter, served only from the authorized `/Users/dmy/Projects/Nodon-R0` compiled tree. `R0Host`, its `ProjectStore`, its `CommandQueue`, `AiAuthority`, and `CandidateManager` share one Node authority. Canvas renders Node snapshots and submits intentions. It does not advance Runtime, predict contacts, validate edits, derive trial qualification, or commit a candidate.

No credential reader, provider client, model request, account system, arbitrary file importer, or product persistence is created by this entry point. Product configuration remains DeepSeek-V4.1-Flash-1017 and 20 CNY; Web candidate preparation is explicitly `controlled_fixture`. Browser evidence is `machine_test` / `machine_browser_input` / `automation_test`, including browser automation using real key events. It is never relabeled as human operation.

Run from the unique actual root after the normal TypeScript build:

```sh
node dist/src/host/web-server.js --port 4180
node dist/src/host/web-server.js --port 0 --verification-mode
```

Binding is hardcoded to `127.0.0.1`. Port `0` requests a real allocated port. The one-line startup manifest reports actual URL, build ID, storage class, and verification-mode status; it contains no CSRF token, writer token, credential, or provider secret. Startup defaults to the fixed `scene-a` catalog.

## Transport boundary

- Host must equal the exact actual `127.0.0.1:<port>` authority. Any supplied Origin or Referer must match its exact origin; Fetch Metadata must be `same-origin` or `none` when supplied. Every POST requires the exact Origin.
- Every POST requires JSON content type, a JSON object, at most 1 MiB, valid UTF-8, no duplicate JSON keys, exact route fields, a valid connection lease, and the short session CSRF header. Unknown routes or fields fail closed.
- Static assets are exactly `/`, `/app.js`, `/styles.css`, read from the new `src/adapters` directory. No arbitrary path, URL, source file, `.env`, `.local`, evidence directory, old prototype, encoded alias, symlink asset, or file-browser route is served. CSP restricts scripts, styles, connections, frames, and objects.
- CSRF tokens remain in the browser closure and request header. The Store writer token stays private to Node. Public snapshots strip private secret field names as defense in depth. No token or connection identifier is placed in an SSE URL.
- General success is `{ok:true,result?,snapshot?}`. Errors are `{ok:false,error:"E_*"}` with no internal stack, arbitrary exception message, or private binding.

## Session and snapshot

`GET /api/session` serially revokes the previous lease, pauses Runtime, clears held keys and pending preview, revokes candidate authorization, and returns:

```json
{
  "ok": true,
  "serverInstanceId": "startup UUID, public",
  "connectionId": "connection UUID",
  "csrfToken": "short private browser token",
  "sessionExpiresAt": 0,
  "heartbeatIntervalMs": 250,
  "heartbeatTimeoutMs": 1000,
  "snapshot": {}
}
```

Session expiration is ten minutes using Node monotonic time. `sessionExpiresAt` is a display wall timestamp. An initial connection is unfocused. The current committed document and previous run/candidate evidence remain in memory on refresh or reconnect. A newly issued lease cannot revive an old candidate. Adult authorization must be explicitly enabled again following revocation.

`GET /api/snapshot` requires `X-Nodon-Connection`. `GET /api/events` uses a fetch-stream SSE reader with the same header and no query. Each SSE record is `event: snapshot` with `data:` equal to the direct snapshot object. The browser must not use native EventSource with a URL token. A replacement stream under the same lease replaces the old response; its late close is ignored unless both captured lease and captured stream still match the current values.

Snapshots contain `buildId`, `serverInstanceId`, `buildStatus`, `catalogId`, fixed available catalogs, storage/provenance labels, public connection state, `document`, `derived=host.inspect()`, domain `entityRadii`, current formal `run`, formal `history`, `clock`, public `authority`, `candidate`, safe `preview`, selected `observations`, and archived catalog state. `derived` exposes Node counts, total collectible score, target, playability/errors, and remaining budget. The current RunSnapshot includes actual Node positions, ticks, input history, frames, genuine events, diagnostics, and truncation; candidate trial Runtime remains under `candidate.trial.run`.

The browser compares public `serverInstanceId` values across reconnects. A changed instance means the process restarted with controlled initial state. It must state that distinction from a same-instance reconnect, preserve local unsubmitted form text, and require explicit retry/new authorization. No restart restores committed product storage or silently resumes gameplay.

## Fixed Node clock and input audit

Runtime advances only through Node's monotonic fixed `1/60` clock and `Host.stepClock` on the common queue. Each pump catches up at most five ticks and discards excess wall backlog; it records `droppedWallTicks`. A queue-time loss predicate checks active lease, focus, SSE connection, heartbeat age below 1000 ms, and session expiry before executing any logical step.

The browser sends held direction changes, not ticks. `POST /api/input` requires:

```json
{
  "sequence": 1,
  "runId": "actual Node run UUID",
  "generation": 1,
  "clientSentAt": 0,
  "direction": { "x": 1, "y": 0 }
}
```

The direction object is the transport representation of the frozen `x/y` fields; both signed components are preserved unchanged. `clientSentAt` is the browser's `Date.now()` observation and never drives simulation. Node rejects old/noninteger sequences, old run IDs, generations, connections, malformed directions, missing sender timestamps, or input while paused. Sequence is monotonic per lease and need not be consecutive.

The clock audit records the exact sender fields plus Node wall `receivedAt`, Node `receivedAtMonotonicMs`, `receivedTick`, attempted tick, actual committed `effectiveTick`, commit flag, apply monotonic timestamp, and superseded status. A receipt alone never advances Runtime. When several updates arrive before one logical step, superseded receipts have no effective tick. Faulted/uncommitted attempts do not claim an effective tick. At most 1000 transport receipts remain, with total/dropped counts; genuine Runtime input/frame evidence remains separately owned by RunSession. `clock.initialState` is the genuine initial frame.

`POST /api/heartbeat {}` is sent every 250 ms. A missing heartbeat for 1000 ms blocks the next logical step, pauses, clears held input, invalidates the lease, and revokes candidates. `POST /api/focus {focused:false}` synchronously blocks further queued logical steps before awaiting pause; focus true never resumes. SSE disconnect has the same barrier and candidate revocation. Reconnect/focus requires an explicit start/resume action. An old stream close cannot pause a new stream or lease.

## Mutations

Every POST below uses `Content-Type: application/json`, `X-Nodon-Connection`, and `X-Nodon-CSRF`:

- `/api/run {action:"start"|"pause"|"resume"}`. Start/resume require a focused live SSE stream and unexpired heartbeat. A start creates a new run/generation; resume preserves the paused run. Both use machine browser provenance.
- `/api/focus {focused:boolean}`, `/api/heartbeat {}`, `/api/adult {enabled:boolean}`, `/api/scope {enabled:boolean}`. Adult/scope changes run through the shared AiAuthority queue. Revocation cannot be undone by a delayed old response.
- `/api/command {action:"preview",commandId:UUID,expectedRevision:integer,command:ManualCommand}` pauses and validates a Store preview without consuming allocation IDs, undo state, or revision. Success returns `{previewId,result}`. Snapshot preview exposes only ID, command, expected revision, and preview result. `/api/command {action:"confirm",previewId}` commits the exact Node-held envelope using the private writer token; `/api/command {action:"cancel"}` discards preview. Browser-supplied writer bindings or replacement commands are rejected.
- `/api/event-selection {eventIds:string[]}` pauses and calls formal `host.observe`. Node returns actual missing-cause/truncation status. Candidate event IDs cannot be submitted to the formal run observation path.
- `/api/candidate/prepare {requestId:UUID,operations:Operation[]}` creates an explicitly controlled candidate, using the shared queue and actual host revision/auth/build bindings. `/api/candidate/trial {candidateId}` runs the real isolated Node trial asynchronously. Web scheduling yields 250 ms per slice so running/cancel states are observable. Formal Runtime is not stepped by candidate trial.
- `/api/candidate/confirm {candidateId,commandId?:UUID}` uses the Node-held candidate and qualification; no browser `passed`, operations, candidate state, proof, or private authority fields are accepted. `/api/candidate/reject {candidateId}` cancels. Candidate snapshots expose source, operations/state, actual trial, coverage, eligibility error, and Node-derived `canTrial`/`canConfirm`.
- `/api/catalog {catalogId:"scene-a"|"scene-b"|"zero-guard-route",confirmReset:true}` is an explicitly labeled controlled reset. It pauses, revokes old authority, retains old read-only in-memory documents/evidence, and creates exactly one new Host/Store/Authority/Manager for the selected fixed project. It accepts no file path or URL. It clears preview/selection and requires explicit new run and candidate authorization.

The process watches build closure paths. A watcher-invalidated cache is synchronously refreshed; prepare/trial/confirm force a fresh build recomputation before entering the candidate manager. A watcher or build-read failure fails closed. Changed artifacts yield `restart_required`; unavailable identity yields `build_unavailable`, blocked clock, unavailable candidate confirmation, and retained in-memory document. Snapshot/publish failure has a guarded fallback rather than an uncaught process crash.

## Evidence and recovery

`POST /api/evidence {target:"formal"}` pauses the genuine formal RunSession and exports through the Node-only Host API into the fixed build's `04_runs` package. Its `assertions.json` additionally carries transport trace version, server instance, the actual initial frame and retained sender/receive/effective input records, explicit machine provenance, Node environment, and HTTP User-Agent marked **unverified**. The normal package manifest covers that file. `run.json` retains its actual Node execution environment and `browser:null`; an HTTP header is not browser environment certification or human evidence.

The response reports `runPath`, `runId`, `exportedTick`, `currentTick`, and `existing`. Repeated requests return the original package reference and original exported tick, without overwriting old evidence. A resumed later tick does not replace the first export under that run ID. Start a new run to create a new package.

`POST /api/evidence {target:"candidate",candidateId}` exports the actual candidate trial RunSession and a `06_candidates` proof through CandidateManager. A theme-only static candidate returns `runPath:null` and a static proof, without fabricating Runtime coverage. A running trial must first finish or be canceled. No endpoint accepts export destination, arbitrary assertion content, or evidence path. Failures preserve the document and old evidence; UI offers retry/cancel of the export action. This operation is explicitly evidence export, not product Save.

`POST /api/verification {incident:"simulated_connection_loss"}` exists only with `--verification-mode`. It labels the incident `verification_only_simulated_connection_loss` and exercises the normal pause/revoke path. It does not claim a real network outage, disk guarantee, or persistence test. Default mode rejects injection.

## Verification boundaries

`verification/runtime-clock.test.ts` probes real Runtime with injected monotonic time and visibly synthetic build identity. `verification/web-server.test.ts` probes the actual loopback HTTP boundary with visibly synthetic identity. They do not establish a genuine build package, visual Canvas correctness, human operation, or provider behavior. Actual build, actual browser operation, fault/recovery observations, exported package audit, and independent review are recorded separately by the root task.

## HTTP receipt recovery and clock barrier

A confirmed manual preview retains its immutable completion receipt for the lifetime of the current Host, across same-process lease replacement. Retrying its preview ID returns that receipt without executing again, consuming another revision, or pausing an unrelated new run. Revocation clears only an unsubmitted preview. An unsubmitted old preview cannot execute after reconnect. Explicit catalog reset replaces the Host and clears receipt recovery; a process restart has no receipts. This is recovery of a command acknowledgement, not product persistence.

Candidate confirmation no longer pauses before consulting its once-only receipt. Actual revision commits synchronously block and clear the Node clock through the Host revision listener; Host already pauses metadata-only runs and invalidates semantic-change runs. Replayed successful confirmations and rejected confirmations do not pause a new formal run.


## R0 session and candidate display correction (2026-11-02)

The absolute ten-minute lease, one-second heartbeat timeout, explicit adult reauthorization, and nonrevival of old candidates remain unchanged. Public connection snapshots additionally expose `leaseDurationMs`, Node-computed nonnegative `leaseRemainingMs`, the current `revocationReason`, and `lastRevocationReason` preserved for a same-process replacement lease. No token is added to public UI or stream URLs. The timer distinguishes `session_expired` from `heartbeat_timeout`. When the captured stream is writable, revocation first blocks input, awaits pause/revocation, sends the canceled snapshot and reason, then ends that stream; broken transport does not guarantee final delivery. A later lease can still show the last reason. This is in-memory diagnostic state, not a durable incident log.

The browser must show an expiring-session warning and distinguish current committed values from a proposal awaiting confirmation. A 15-minute comparison-side limit does not extend a ten-minute lease or establish uninterrupted availability. Manual reconnect does not restart the study stopwatch, revive a candidate, resend a frozen slot, or enable adult permissions. Historical PAIR02's exact disconnection cause remains unproven by this correction.

Terminated candidates retain only their Node-validated original operations in a separately labeled read-only `historicalOperations` field. Active `operations` still clears, `candidateState` and the private draft still clear, and `canConfirm`/`canTrial` remain false. Historical operations are display evidence, never accepted as a new commit or trial. Invalid candidates with no valid operations do not gain fabricated history. Original provider-response fallback, when displayed, must be labeled as historical raw response rather than a currently valid proposal.

A heartbeat POST can discover expiry before the timer delivers the final SSE record. For `E_LEASE_EXPIRED` only, the server may return the fully revoked safe snapshot on that error response after awaiting revocation, provided the request used the exact current lease, exact origin and valid CSRF header. After awaiting, it rechecks that the captured lease is still current. Wrong/old connection identifiers, wrong CSRF, cross-origin requests and other errors receive no recovery snapshot. This does not renew a lease or enable an operation. It lets the browser apply the authoritative canceled state before closing its stream. The session status stays visible while scrolling to a candidate so the expiry warning can be seen at the confirmation controls.
