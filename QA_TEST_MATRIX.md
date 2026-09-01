# Adversarial QA test matrix

Last full run: 1 September 2026, against the commit this file ships in. The
previous run belonged to `309cbed`; these numbers do not.

- `npm run verify` - **711/711**, exit 0, run on 1 September 2026 from this
  working tree, and again with `PORT=10000`, `NSWR_TRUST_PROXY=1` and
  `NSWR_TRUST_CF_CONNECTING_IP=1` set the way the build environment sets them.
- `npm run test:browser` - **292/292**, exit 0, run on 1 September 2026 from this
  working tree on Chrome 151.0.7922.174 with Edge 152.0.4191.53. It needs a real
  browser, so no offline gate can reproduce that figure.

A commit this record does not name has not been measured here. Two commits on
31 August each added a test and each bumped the total below without touching
this line, which is why the line now carries a build and a clock.

**What this record is, and what it is not.** It is a dated measurement, written
by hand after a run. It is not cryptographic proof that the checkout you are
reading was the one measured, and it cannot be: a file cannot carry the hash of
the commit it is part of. The guard beside it checks that the record is
internally consistent and names exactly one build - not that any run happened.
The exact final SHA and the full command output live in the release report,
outside this commit, where they can name the build without being part of it.
Four matching frontend hashes prove those four files and say nothing about the
backend.

This is the regression contract for the demo. A release is green only when both
commands pass from this directory:

```powershell
npm run verify
npm run test:browser
```

The browser suite launches Chrome with a throwaway profile. It must not reuse or
modify a personal Chrome profile. `NSWR_BROWSER=edge` (or `NSWR_BROWSER_PATH`)
runs the whole suite against another Chromium build; whichever engine drives the
run, one scenario also opens Microsoft Edge when it is installed and records
what that engine really exposes.

Latest measured result, on the commit this file ships in: **711/711 Node tests** and **292/292 Chrome checks**
passed. The Node figure is reproducible offline from a clean checkout of that
commit; the Chrome figure is a dated measurement rather than a computed one,
because producing it needs a browser. Neither figure covers a later commit.

Measured on 30 August 2026 in **Microsoft Edge 152.0.4191.53**, recorded rather
than assumed: Edge exposes `document.modelContext`, registers all seven tools
(six imperative plus the declarative form), reports **5 read · 2 write**, and
completes a booking end to end. The suite does not require that — where a
Chromium build has no WebMCP, the same scenario requires the page to say
*Manual demo mode*, expose no tool chips, and stay usable.

## Release gates

| ID | Attack or behaviour | Required result | Automated evidence |
|---|---|---|---|
| INPUT-01 | Call every **imperative** write tool with `{}`: `find_access_bundle`, `stage_access_bundle`, `replan_access_bundle`, `clear_access_plan`, `report_facility_outage`, `restore_facility` | Every one of the six refuses locally with a readable message naming what is missing, and issues zero HTTP requests. The six are read off the registered surfaces rather than typed into the test, so a new write tool is covered the day it is added. The declarative `set_access_requirements` is deliberately outside that set: Chrome registers it from the markup in `public/index.html`, never from `public/tools.mjs`, and by design it retains omitted visible values and can stay pending for human submission - HITL-01 and HITL-03 cover it instead, in a browser | `test/tools.test.mjs` — *malformed tool inputs are refused before any HTTP call*; `e2e/browser.mjs` |
| INPUT-02 | Imperative missing, unknown, wrong-type, out-of-range and invalid-enum arguments | Rejected by the tool wrapper; domain state unchanged | `test/tools.test.mjs` |
| INPUT-03 | Blank required number fields in the visible form | Native form validation blocks submission | `e2e/browser.mjs` |
| STATE-01 | Facility fails after a plan is staged | Stale plan refused; zero partial reservations | `test/domain.test.mjs`, `e2e/browser.mjs` |
| STATE-02 | Repair a facility after `NO_ALTERNATIVE` | Old refusal is invalidated and planning can resume | `test/hardening.test.mjs` — *a venue repair reopens replanning after no alternative existed*; `e2e/browser.mjs` |
| STATE-03 | Replan repeatedly and clear plans repeatedly | Superseded plans and confirmations do not accumulate | `test/hardening.test.mjs` |
| STATE-04 | Confirm the same plan twice | Exactly one booking; idempotent result | `test/domain.test.mjs` |
| STATE-05 | Try to create a plan after a booking exists | `BOOKING_ALREADY_EXISTS`; existing booking unchanged | `test/domain.test.mjs` |
| STATE-06 | Arm an outage for an already failed facility | Refused without changing venue state | `test/hardening.test.mjs` — *outage validation and arming stay strict after a lift is already down* |
| STATE-07 | Submit an invalid confirmation while a fault is armed | Confirmation is rejected before the fault can mutate state | `test/hardening.test.mjs` — *an invalid confirmation cannot trigger the armed venue fault* |
| STATE-08 | Omit the outage reason | Refused; facility and revision unchanged | `test/hardening.test.mjs` — *an outage reason is required instead of silently defaulted*; `e2e/browser.mjs` |
| HITL-01 | Execute declarative `set_access_requirements` | It remains pending until the visitor presses the visible submit button, then completes | `e2e/browser.mjs` |
| HITL-02 | Inspect every page state for a tool that could prepare or commit a confirmation | No registered WebMCP tool can prepare or commit a booking. Confirmation is performed through the visible page flow; direct authenticated HTTP is outside the tool-surface boundary, and the server does not claim to prove a human was present | `test/tools.test.mjs` — *no registered tool can prepare or commit a booking, in any page state*; contract eval, `e2e/browser.mjs` |
| HITL-03 | Send declarative zero, range, wrong-type, null or unknown-key values | Invocation rejects instead of hanging; the form resets and becomes inactive. Every request the page issues is recorded through CDP `Network.requestWillBeSent`, and the zero-valued window is read twice over that log: every request is a `GET`, and no request's parsed `pathname` is `/api/plans`, `/api/session`, `/api/demo` or a path below one. The pathname is compared, not searched for in the URL, so neither a demo id nor a query parameter can stand in for an endpoint. A successful request would be invisible to a failed-response count, and a `GET` of somebody's plan would be invisible to a method check | `e2e/browser.mjs` |
| TOOLS-01 | Move through all seven declared phases: READY, PLAN_READY, AWAITING_HUMAN_CONFIRMATION, PLAN_STALE, REPLAN_READY, NO_ALTERNATIVE, CONFIRMED | In each one the browser registry is the **exact** sorted set the phase declares, the visible badge matches the declared read/write counts, and the chips match the registry. Expectations are derived from the same `availableIn` declarations the page registers from, never typed by hand. The run fails if any phase was never reached | contract eval, `e2e/browser.mjs` |
| TOOLS-02 | Invoke each tool marked read-only on **both** surfaces, the operator's `get_facility_status` included | Venue state is byte-for-byte unchanged after each one; the covered set is asserted by name so a new read-only tool cannot slip through unexercised | `test/tools.test.mjs` — *a tool marked read-only leaves the venue untouched* |
| API-01 | Cross-site and role-mismatched writes | Refused, and an authorised snapshot of the whole venue is byte-for-byte identical either side of the refusal. A handler that mutated first and checked afterwards would return the same 403 | `test/http.test.mjs` — *HTTP API isolates demo sessions, roles and cross-site writes*; `test/hardening.test.mjs`, `e2e/browser.mjs` |
| API-02 | Send inherited-property identifiers and malformed bodies | No prototype lookup or malformed mutation succeeds | `test/hardening.test.mjs` |
| BROWSER-01 | Reload plus visitor/operator tabs on one shared venue link | Same demo and correct role-specific tool surfaces survive | `e2e/browser.mjs` |
| BROWSER-02 | Rapid double-click on build and confirm | One logical transition; no duplicate resources | `e2e/browser.mjs` |
| A11Y-01 | Keyboard-only visitor flow | Visible focus reaches controls and the flow completes | `e2e/browser.mjs` |
| A11Y-02 | 320, 375, 768 and 1440 px viewports | No horizontal overflow; Copy is at least 44 by 44 px at 320 px | `e2e/browser.mjs` |
| FAILURE-01 | Trigger the intentional stale-plan conflict | UI explains the refusal and still offers explanation/replan | `e2e/browser.mjs` |
| FAILURE-02 | Replan around the failed East Lift and confirm | Garden route commits atomically; `partialReservations` remains `0` | `test/domain.test.mjs`, `e2e/browser.mjs` |
| OBS-01 | Watch console and network in routine flows | No unexpected console error or HTTP 4xx/5xx | `e2e/browser.mjs` |
| MANUAL-01 | Run the whole failure-and-recovery flow in a browser with no WebMCP at all, using only the visible buttons | Plan, armed fault, refusal, replan and confirmation all complete; zero partial reservations. A `MutationObserver` installed before the first click records every node inserted into the tool list, so a chip that appeared and was removed again is still caught; a probe chip proves the recorder was live | `e2e/browser.mjs` |
| ENGINE-01 | Open the page in Microsoft Edge | Whatever Edge exposes, the badge matches it and a booking completes; no WebMCP means *Manual demo mode*, not an invented surface | `e2e/browser.mjs` |
| NARROW-01 | 375 px: the header's live indicator is hidden by design | The refusal card, its venue revision and the partial count stay reachable; a venue that goes stale becomes visible at that width | `e2e/browser.mjs` |
| RESTART-01 | Restart the server under a page holding a staged plan or a booking | Old session refused, old plan identifiers dead, no booking or reservation resurrected | `test/resilience.test.mjs` |
| RESTART-02 | Reopen the same `?demo=` link after a restart | The page says the venue is gone instead of presenting the rebuilt empty one as real; announced assertively | `e2e/browser.mjs`, `test/resilience.test.mjs` |
| RESTART-03 | Confirm while the server is unreachable | The failure is announced, the button is released, nothing is booked, no unhandled rejection | `e2e/browser.mjs` |
| CONC-01 | Eight genuinely parallel HTTP plan creations and confirmations | Exactly one plan, exactly one booking, three reserved resources all owned by it | `test/resilience.test.mjs` |
| CONC-02 | A confirmation and an operator outage over HTTP: commit-first, outage-first, and a repeated parallel race | Either the whole bundle or none of it; the outage-first refusal explicitly carries `partialReservations: 0` rather than letting an absent field pass as zero | `test/resilience.test.mjs` |
| AUDIT-01 | Attribution of an action to an agent | `X-WebMCP-Tool` alone decides it; the visible log shows the tool name, and the same call without the header reads *Human UI* | `test/http.test.mjs`, `e2e/browser.mjs` |
| LIMIT-01 | Vary the leftmost `X-Forwarded-For` element on every one of 60 session creations from one caller | 40 accepted then 20 refused; no request after the first refusal is accepted. Before the fix this was 60 accepted and 0 refused | `test/hardening.test.mjs` — *a caller cannot mint limiter buckets by varying the forwarded header* |
| LIMIT-02 | Exhaust one trusted client, then arrive as a different one | The first stays refused, the second is served; a valid IPv6 caller is its own bucket | `test/hardening.test.mjs` — *one exhausted visitor does not lock out a genuinely different one* |
| LIMIT-03 | Proxy trust enabled but the provider header absent, forwarded chain varied | Falls back to the socket bucket; the forwarded chain is never promoted to an identity | `test/hardening.test.mjs` — *the forwarded header alone is never a trusted identity* |
| LIMIT-04 | Empty, whitespace, `not-an-ip`, a two-address chain, malformed IPv6, out-of-range IPv4 and a host:port pair as the trusted header | Every one falls back instead of naming a bucket; a well-formed address is still honoured | `test/hardening.test.mjs` — *a malformed trusted header falls back instead of naming its own bucket* |
| LIMIT-05 | No proxy trust configured; vary both proxy headers across 60 requests | The socket bucket is used and the caller is limited | `test/hardening.test.mjs` — *without proxy trust configured the forwarded headers are ignored* |
| LIMIT-06 | Set the retired `NSWR_TRUST_PROXY` variable and vary the forwarded header | The variable does nothing; the caller is still limited at 40. This goes red if the retired `NSWR_TRUST_PROXY` variable regains its former effect, or if forwarded-header trust becomes unconditional. It cannot detect a differently named variable that has never been written; LIMIT-03 and LIMIT-05 are what cover the untrusted case | `test/hardening.test.mjs` — *the retired proxy variable cannot switch forwarded-header trust back on* |
| API-04 | `HEAD` on all ten static routes, an unknown path and a write method | Status, `Content-Type`, `Cache-Control`, CSP, `Origin-Agent-Cluster`, `Permissions-Policy`, `Referrer-Policy` and `X-Content-Type-Options` all equal to `GET`, with a zero-length body; an unknown path is still 404 and a write method is still refused | `test/http.test.mjs` — *HEAD answers a static route the way GET does, without a body* |
| API-05 | Two distinct visitor sessions created against the same `demoId` | The session that created no plan can prepare a confirmation and commit the other session’s staged plan over plain HTTP. The first session then sees exactly one booking with zero partial reservations. This proves cross-session behaviour within one shared venue store; URL parsing and navigation are outside this test. It is why the receipt claims only that a visitor session confirmed the booking | `test/http.test.mjs` — *a second visitor session on the same venue can confirm the first one’s plan* |
| DOC-01 | Scan the public artifacts for a claim the server cannot prove | Neither `you approved it` nor `a person on this venue link confirmed it` appears in `public/app.js`, `public/index.html` or `README.md`, and the provable wording is present in both the script and the static fallback | `test/documentation.test.mjs` — *no public artifact claims the reader approved the booking* |
| API-03 | The refusal branches listed here, which are not all of them: absent session, unknown session token, missing `Origin`, unparseable `Origin`, cross-site fetch metadata, unparseable JSON, oversized body, bad role, bad demo id, unknown API route, write method on an API route, non-GET static file, unknown static path | Two kinds of refusal, and only one is named. JSON API refusals carry an `error.code`; the static router answers `Not found` as plain text with no JSON body, deliberately - so this row does not claim every refusal is named. Both carry the full header set - `Cache-Control`, CSP, `Origin-Agent-Cluster`, `Permissions-Policy`, `Referrer-Policy`, `X-Content-Type-Options` - and every refusal the test produces is checked, not a listed sample of them. Covered elsewhere and deliberately not here: `ROLE_FORBIDDEN` and the `Origin`-host mismatch (API-01), `INVALID_PATH` and the non-object JSON body (API-02), `TOO_MANY_SESSIONS` (LIMIT-01 to LIMIT-06). Two branches nothing in the suite reaches at all: `DEMO_NOT_FOUND`, and `INTERNAL_ERROR`, which needs fault injection | `test/http.test.mjs` — *the listed refusal branches are reachable, and each is named or the plain 404* |

## Acceptance suites

The release gates above grew out of adversarial thinking about the protocol. They
were thorough about the domain and silent about the visitor: a stale event date, a
plan a person could not back out of, a refusal that erased itself after four
seconds and a map that cannot draw a failure all shipped green. These suites cover
the product the way somebody using it meets it, and they run in `npm test` with
everything else.

| Suite | What it holds to account |
|---|---|
| `test/uat/requirements.uat.test.mjs` | Every requirement field at and just outside its bounds, and every combination of the three booleans. Pins that wheelchair width 95 is inside the form's own `max` and satisfiable by no route, at any setting of the others |
| `test/uat/phases.uat.test.mjs` | Every domain mutation attempted from every one of the seven phases, asserting the resulting phase or the exact error code, plus the recovery path out of each |
| `test/uat/tools-matrix.uat.test.mjs` | Every tool in every phase it is registered for: exact sorted names, read/write counts, output budget, and that no description promises more than its `execute` returns |
| `test/uat/operator.uat.test.mjs` | Both lifts, every outage and restore ordering, repeats and no-ops, invalid reason codes, and what each transition does to open plans and to an existing booking |
| `test/uat/booking.uat.test.mjs` | The booking lifecycle and atomicity: double confirmation, stale revisions, cleared plans, idempotency keys, and reserved-resource counts either side of every path |
| `test/uat/refusals.uat.test.mjs` | The refusal codes in `lib/domain.mjs` and `server.mjs` pinned as exact sets, 27 and 14, so one cannot be added without a test; and for each code the suite can reach, its status, its message and the next action an agent is given. Two are named as unreachable rather than covered: `DEMO_NOT_FOUND`, whose sessions are evicted in the same sweep, and `INTERNAL_ERROR`, which needs fault injection. Two reachable refusals have no next action of their own, and the suite pins that they fall through to the generic one |
| `test/uat/http-contract.uat.test.mjs` | Fourteen guarded routes and nine static ones against each way of getting them wrong - session, role, origin, fetch metadata, method, body - with the exact status, the exact error code and all six security headers asserted on every response the suite produces. Both route lists are typed into the test rather than read out of `server.mjs`, so a route added there is covered only when somebody adds it here too |
| `test/uat/shared-venue.uat.test.mjs` | Two sessions on one venue, role isolation, and whole-venue snapshot equality either side of a refused write |
| `test/uat/dom-contract.uat.test.mjs` | The contract between the HTML and the JS: every queried id exists, every ARIA reference resolves, every button has a name. Static, no browser |
| `test/uat/resilience.uat.test.mjs` | Log and plan growth bounds, the session limiter and its trusted-header rules, and that a restart resurrects nothing |
| `test/uat/regressions.uat.test.mjs` | One test per defect found by using the deployed app: the stale event date, the plan with no way back, the disabled control that lied, a phase label naming a control that phase hides, the refusal that erased itself, and three copy claims the page could not support. Run whole against `cf376a1`, 14 of its 17 cases fail there and 3 pass: the escape that does not depend on the incident card, which passes only because that build had no such control at all, and the two document-consistency checks, which `cf376a1` already satisfied. The label case is newer than `cf376a1` and was written against `2d7d08b` |
| `test/uat/map-and-operator.uat.test.mjs` | The map, and the operator page's human controls - not the operator page as a whole, whose tool surface and HTTP routes were already covered elsewhere. That the map can draw a failure at all, that it follows whichever lift the plan uses rather than one hardcoded id, that the garden route ends on the wheelchair space, that a human control exists for every lift the venue reports, and that every control whose action follows the facility selector rewrites its own label instead of naming one lift in static markup |
| `test/uat/source-hygiene.uat.test.mjs` | Properties of the source itself: no invisible control character, every script parses, no suite registers nothing. Written after a lone backslash-b inside a template literal became a real backspace six times in one session, each time silently |
| `test/uat/suite-integrity.uat.test.mjs` | Properties of the gate itself: no suite or harness binds a port written into the file, in any case of the identifier; nothing outside `test/helpers/test-server.mjs` spawns a server; that one launcher asks the OS for a port, requires its own instance token and watches its own child; and neither page decides armed state from a hardcoded lift. It asserts the architecture only - the readiness BEHAVIOUR is proved by running it, in `test-server.self.test.mjs`, because the earlier per-file text search passed on a guard referencing an undeclared binding and on four written-in ports it was reading directly |
| `test/uat/pending-fault.uat.test.mjs` | A pending venue fault is defended by the venue, not by the pages that show it: arming a second facility is refused with `OUTAGE_ALREADY_ARMED` and changes nothing, re-arming the same one is idempotent and writes no second audit line, and the invariant holds over real HTTP, which is where it was reachable |
| `test/uat/declarative-tool.uat.test.mjs` | The declarative form is a whole WebMCP tool or none at all: no shipped form carries `toolname` without `tooldescription` or the reverse, both attributes are written from one place in both directions, and the real swap is run against a DOM applying Blink's own predicate after every mutation. Written after Chrome DevTools filed kFormModelContextMissingToolDescription against the live page for a description set one statement too late; a CDP Audits probe measured 2 issues before the fix and 0 after |
| `test/uat/unsatisfiable-limits.uat.test.mjs` | A limit no route can meet is refused with the number that would work. maxDistanceM accepts from 20 m while nothing plans under the venue floor, and every value in that dead band drew the same sentence as an ordinary near-miss, so an agent was told no and not told what would be yes. The floor is measured from the venue at runtime and asserted to appear nowhere in the shipped source, because raising the published schema minimum would freeze today route data into the contract |
| `test/uat/views.uat.test.mjs` | The two page decisions that kept naming the wrong lift, as pure functions both pages and these tests import. The visitor fault control read the East outage before the armed fault, so with East out and Garden armed it offered a restore while setting aria-disabled=true - naming an action it would refuse. Every mode is now asserted to send exactly what it names, and a disabled control to send nothing. Decision-log titles resolve the facility from the entry own refs, so an arm is titled for the lift it armed and never for the other one |
| `test/uat/dead-end-advice.uat.test.mjs` | The advertised next action follows the diagnosis shipped beside it. With both lifts out the venue answered requirementChangeCanHelp false and nextAction CHANGE_REQUIREMENTS in the same object, so an agent following the advice would loop. The rule is reachability, not the blocker list: both lifts out plus a distance blocker is still CONTACT_VENUE_STAFF, while one lift out plus a relaxable distance is still CHANGE_REQUIREMENTS. Asserted equal across domain, HTTP and the explain call |
| `test/uat/ready-explanation.uat.test.mjs` | A refusal that opened no plan is still explicable. From a fresh visit with every lift out the search refuses, no plan exists, the phase stays READY, and explainRefusal used to answer Nothing is blocked - so registering the tool in READY without this made the tool present and wrong rather than absent. The stored context holds the question only, never the answer, and is re-evaluated against current resources on every read, so a repaired venue answers blocked false and a venue that closed further is described by what blocks it now. It lives outside the snapshot: one visitor refused search is not venue state |
| `test/uat/client-revision.uat.test.mjs` | A number the caller got wrong is not a venue change. commitBundle compared the caller revision in the same condition as the plan and the confirmation, so a stale tab or a typo produced STALE_RESOURCE_VERSION and pushed a plan nothing had invalidated to STALE - reporting two identical revisions, an empty rule list, and offering back the route the plan already held. The check also ran after the demo fault had been triggered, so a bad number could spend a fault armed for a real confirmation. Wrong numbers now answer EXPECTED_RESOURCE_VERSION_MISMATCH, change nothing, and leave the plan confirmable; a venue that really moved is still STALE_RESOURCE_VERSION |
| `test/uat/tester-findings.uat.test.mjs` | What an independent adversarial pass reproduced by driving the frozen release. Disarming an armed fault was written to the decision log as FACILITY_RESTORED and bumped the venue revision, so a restoration that never happened pushed a valid STAGED plan to STALE; a dead-end explanation named only the plan's own lift and dropped the two fields an agent decides with; it also named a rejection from a previous, fully recovered episode, because it took the last REJECTED entry ever written; a booking receipt counter was private per venue, so on one process every visitor's first booking carried the same reference; and the idempotency map was never pruned, so a caller could grow it without limit and make each later refusal cost more than the last |
| `test/uat/diagnosis-surface.uat.test.mjs` | Everything the venue diagnoses reaches the agent that asks. `shortestFeasibleDistanceM` - the shortest route the venue actually has, and the one value that turns "no plan" into a distance worth asking for - was computed on every distance-only dead end and dropped by all four surfaces that forwarded the diagnosis field by field, `explain_access_refusal` included. The fields are named once and forwarded as a unit now, and the last test derives the diagnosis's own field list at runtime, so a field added later is covered on the day it is written rather than dropped for the third time |
| `test/uat/tester-round-two.uat.test.mjs` | The second adversarial round, against the repaired release. `explain_access_refusal` answered blocked / CONTACT_VENUE_STAFF for a venue in which the very next search books a seat: a replan excludes the route it replaces, and that exclusion outlived the plan it belonged to, so the explanation evaluated one route out of two. One visitor's refused search was also reported to a second visitor who had made no call, together with the first visitor's access requirements, while the source comment beside that state says a refused search is not venue state. A refusal is per visitor and bounded now, and clearing a plan drops the exclusion without dropping the question, so a venue that is still shut stays explicable. A staging refusal asked an agent to retry with a confirmation revision at a point where no confirmation exists |
| `test/uat/page-claims.uat.test.mjs` | Four sentences the visitor page said that were not true of the page saying them. The standing refusal banner told a visitor to change a requirement while the server's answer to that very call said no requirement change can help - incidentView already handled this, but the incident card renders only in PLAN_STALE and NO_ALTERNATIVE, so a READY-phase refusal never reached it. Replanning around an outage on the OTHER route announced ALTERNATIVE FOUND, "The route changed" and "Accept the replacement plan" over a byte-identical route, while the domain cleared the exclusion list precisely because the route still worked. A confirmed booking restated the CURRENT venue revision as the one it was committed at, contradicting the receipt beneath it. And the build control claimed a plan was being prepared in a state that is terminal if no agent ever stages it. Three of those repairs were then shown by the mutation matrix to be untested: the decisions lived in `public/app.js`, which no Node test can import, so each was covered by a search of the source for a name - and a name survives a mutation that empties the thing it names. `focusRefuge`, `bookedResourcesOutOfService` and `bookingBreakageAnnouncement` are pure functions in `public/views.mjs` now, imported by the page and by these tests |
| `test/uat/idempotency-and-receipts.uat.test.mjs` | A request id binds on the first execution, refusal included, and a receipt number is unique in a running venue. The id used to bind only on success, so replaying an identical refused command re-ran it and wrote another decision-log entry every time, and a failed attempt could later become a DIFFERENT successful command under the same id. Receipts were derived from the audit sequence, which reset() rewinds, so three booking cycles produced NSWR-00244, NSWR-00245, NSWR-00245 - two bookings in one process sharing a number |
| `test/uat/tester-round-three.uat.test.mjs` | The third adversarial round, and the one that found a repair which had never taken effect. A refusal was supposed to belong to the visitor who made it: the domain took a session key, the server passed `session.token`, and the test called the domain directly with a key - while `createSession` stored the session without its own token, so every HTTP caller arrived as `undefined` and landed in the shared bucket the repair existed to remove. Every test here goes over HTTP for that reason, including the ones whose logic lives in the domain. Also covers: a committed booking reported as three partial reservations, because the READY branch labelled the raw RESERVED count with the name the README pins at zero; `check_access_route` answering feasible without the five limits the venue filled in, which its sibling tool had already been fixed to disclose; and `restore_facility` describing two of its three cases |
| `test/uat/final-release-regressions.uat.test.mjs` | Defects reproduced after the frozen release had passed every shipped gate: a successful replacement retires plan-scoped exclusions for every visitor; the refusal bound rejects session overflow instead of erasing an active visitor's explanation; the two-hour session TTL is enforced before a request can refresh it and expired refusal records are released; and an explanation preserves whether a direct search or a replacement search was actually rejected, including after the failed plan is cleared. The cross-session, capacity, TTL and action-provenance paths cross the real HTTP boundary; refusal cleanup is pinned directly at the store boundary where that private record lives |
| `test/uat/attribution.uat.test.mjs` | Who the decision log says did a thing, and what that claim is worth. The two operator writes ignored the interaction context, so taking a lift out of service or restoring it was always filed as the venue operator whether it came from the operations page or from report_facility_outage - the one artefact this product asks to be believed was silent about half of what it records. The claim is deliberately modest: X-WebMCP-Tool is a DECLARED invocation path, not an authenticated identity, because an authorised client can send any header. A guard forbids any shipped document from calling it trusted, authenticated or proof of who acted |
| `test/helpers/test-server.self.test.mjs` | The harness proves it tested its own server; this proves the harness. Real impostor servers, real dead children, real cross-matching: a 200 with the wrong token is refused, an owned child that has already exited is refused even when a stranger echoes its token, a live child on a port serving someone else token is refused, a stopped instance stops answering on its old origin, two launches get different ports and tokens and neither validates against the other origin, and the Render-style variables are proved removed by reading back what a child would actually get |

## Expected non-2xx responses

The browser harness uses a scenario-tagged allow-list, not a global exception.
Only deliberately exercised refusal paths may produce non-2xx responses, such as
the stale-plan conflict, cross-site write rejection and malformed raw API request.
Any other console or network error fails the run.

The restart scenario is the one place where a request can fail because there is
no server to answer it. Connection errors are tolerated **only** inside that
scenario, and the run additionally asserts that nothing else was logged there —
an unhandled rejection while the server is away still fails. The 401s the page
collects afterwards are allowed in unbounded number but must occur at least
once: a page that went quiet, or that quietly re-authenticated itself onto a
different venue, would show up as their absence.

## Live ChatGPT desktop case

Run this by hand in the ChatGPT desktop in-app browser, separately from the
scripted Chrome suite. No model is named anywhere in this section: the host
exposed its browser, not whatever was driving it. The steps are:

1. Open a fresh `?demo=<unique-id>` URL.
2. Confirm the pill reports `5 read · 1 write` on the initial in-app-browser
   surface. The declarative form tool may be absent on this host. That number is
   derived from the declarations; the only figure ever measured there is
   `4 read · 1 write`, on build `cf376a1`, before the later tools existed.
3. Call `check_access_route` with `{}` and call `find_access_bundle` with missing
   requirements. Both must return readable refusals without an HTTP error.
4. Find and stage the East route, arm the live fault, then use the visible human
   confirmation button.
5. Require `STALE_RESOURCE_VERSION`, venue revision `2`, and
   `partialReservations: 0`.
6. Call `explain_access_refusal`, then `replan_access_bundle`.
7. Accept the replacement plan in the visible UI.
8. Require phase `CONFIRMED`, Garden Lift L4, one booking, revision `3`,
   `partialReservations: 0`, and a final surface of `4 read · 0 write`.
9. Require no console errors in the completed recovery flow. The deliberate
   stale-plan HTTP conflict is a tested business refusal, not an unexpected error.

**This case is not automated and no gate reproduces it.** Every other row in
this document is asserted by `npm run verify` or `npm run test:browser`; this one
is a manual run, driven by hand and recorded here. The recorded result is that
all nine checks passed on 30 August 2026 against build `cf376a1`, in the ChatGPT
desktop in-app browser.

What that run observed, in order: `4 read / 1 write` in `READY` on build `cf376a1`; readable
refusals for both incomplete calls; the East plan created at venue revision 1;
the confirmation after the lift failure rejected with `STALE_RESOURCE_VERSION`
and `partialReservations: 0`; a replan through the Garden Lift; visible human
acceptance required before anything committed; and phase `CONFIRMED` at revision
3 with booking `NSWR-00251` and a final surface of `4 read / 0 write` on build `cf376a1`. No console
errors.

That measurement covers `cf376a1` and nothing later. Commits after it, up to and
including `309cbed`, have no recorded run in this host, so nothing here says the deployed
build was tested there. Chrome results are not a substitute: ChatGPT desktop is a
different host with its own tool surface and its own per-call review. Re-run it
against the deployed URL before quoting it as current.

## Interpretation note

Chrome's `set_access_requirements` showing **In Progress** is intentional only
when the resulting visible form is valid and waiting for the visitor to submit.
Invalid numeric input must reject and reset immediately. Omitted declarative
fields keep their visible form values; strict explicit completeness is enforced
by the imperative `find_access_bundle`, not Chrome's current form-filling layer.
