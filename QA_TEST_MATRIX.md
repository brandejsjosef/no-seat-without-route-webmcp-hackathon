# Adversarial QA test matrix

Last full run: 2 September 2026, against application snapshot `72845b7` and the
documentation state this file ships in.

- `npm run verify` - **738/738**, exit 0, run on 2 September 2026 from this
  working tree, and again with `PORT=10000`, `NSWR_TRUST_PROXY=1` and
  `NSWR_TRUST_CF_CONNECTING_IP=1` set the way the build environment sets them.
- `npm run test:browser` - **373/373**, exit 0, run on 2 September 2026 from this
  working tree on Chrome 152.0.7977.65 with Edge 152.0.4191.53. It needs a real
  browser, so no offline gate can reproduce that figure.

A later change has not been measured merely because this paragraph exists. The
date and application snapshot scope the recorded browser evidence; documentation
checks are rerun after documentation-only corrections.

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

Latest measured application snapshot, `72845b7`: **738/738 Node tests** and
**373/373 Chrome checks** passed. The Node figure is reproducible offline from a
clean checkout of that snapshot; the Chrome figure is a dated measurement rather
than a computed one, because producing it needs a browser. Neither figure covers
a later application change.

Measured on 2 September 2026 in **Microsoft Edge 152.0.4191.53**, recorded rather
than assumed: Edge exposes `document.modelContext`, registers all seven tools
(six imperative plus the declarative form), reports **5 read · 2 write**, and
completes a booking end to end. The suite does not require that — where a
Chromium build has no WebMCP, the same scenario requires the page to say
*Manual demo mode*, expose no tool chips, and stay usable.

Measured separately in **Firefox 155** with a throwaway profile at 320 x 568:
Firefox exposed no `document.modelContext`, the page truthfully showed *Manual
demo mode*, and the ordinary Build -> review -> Confirm flow produced a receipt
with `0` partial reservations and no console error. This is a recorded fallback
smoke test, not part of the automated Chromium count above.

Lighthouse 13.4.0 in headless Chrome 152, mobile preset, three local release-
candidate runs per page on 2 September 2026: visitor medians **98 / 100 / 100 /
100** and operator medians **100 / 100 / 100 / 100**, in Performance /
Accessibility / Best Practices / SEO order. All six reports completed without a
runtime error. These are automated lab scores, not a manual accessibility audit
or certification.

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
| BROWSER-03 | Build from READY with two, one and zero operational lifts | Two lifts select the preferred East route; one lift selects the only working route; zero lifts create no plan or reservation and leave the Build control available for a truthful retry | `test/domain.test.mjs`, `test/uat/operator.uat.test.mjs`, `e2e/browser.mjs` |
| OPERATOR-01 | Select East or Garden with the visible lift cards, mouse or arrow keys, then let the one-second poll run | The chosen native radio, keyboard focus and DOM node survive the poll; every arm, outage and restore label names the selected lift; selection alone sends no write request | `test/uat/map-and-operator.uat.test.mjs`, `test/uat/presentation.uat.test.mjs`, `e2e/browser.mjs` |
| OPERATOR-02 | Take the lift used by a confirmed booking offline | The first click performs no write and opens an inline acknowledgement naming the booking and consequences; only the explicit second step sends one outage request. Operator and visitor keep the confirmed receipt, show a persistent route-disruption warning, report `1` booking, `3` reserved and `0` partial resources, and clear the warning after restore without deleting the booking | `test/uat/operator.uat.test.mjs`, `test/uat/views.uat.test.mjs`, `e2e/browser.mjs` |
| OPERATOR-03 | Take only the lift not used by a confirmed booking offline, then take both offline | The unrelated outage raises no false booking warning. With both down, the venue reports no working lift route but attributes booking impact only to the lift the booking actually uses | `test/uat/views.uat.test.mjs`, `e2e/browser.mjs` |
| A11Y-01 | Keyboard-only visitor flow | Visible focus reaches controls and the flow completes | `e2e/browser.mjs` |
| A11Y-02 | Portrait viewports 320x568, 360x800, 375x667, 390x844, 412x915 and 768x1024; landscape 568x320, 667x375, 844x390 and 915x412; desktop 1440x800 and 1920x889; then visitor and operator at 320x568 with text enlarged to 200% | No horizontal overflow or clipped WebMCP badge; visitor Copy and home wordmark are at least 44 by 44 CSS px; operator lift cards and controls remain touch sized; the 200% check includes the visitor's open disclosures and reports offending elements when it fails | `e2e/browser.mjs` |
| A11Y-03 | Ask the operating system for reduced motion | The media query is active and removes material button animation | `e2e/browser.mjs` |
| FAILURE-01 | Trigger the intentional stale-plan conflict | UI explains the refusal and still offers explanation/replan | `e2e/browser.mjs` |
| FAILURE-02 | Replan around the failed East Lift and confirm | Garden route commits atomically; `partialReservations` remains `0` | `test/domain.test.mjs`, `e2e/browser.mjs` |
| FAILURE-03 | Press Build while both lifts are already offline and wait beyond the toast lifetime | A persistent inline refusal stays inside the Access plan card and in the viewport, focus moves to its heading, the phase settles back to READY, the button reads `Recheck route availability`, and no progress label or partial reservation remains. Restoring one lift clears the refusal through the ordinary poll and the same button builds a complete route | `test/uat/ready-explanation.uat.test.mjs`, `test/uat/regressions.uat.test.mjs`, `e2e/browser.mjs` |
| OBS-01 | Watch console and network in routine flows | No unexpected console error or HTTP 4xx/5xx | `e2e/browser.mjs` |
| MANUAL-01 | Run the whole failure-and-recovery flow in a browser with no WebMCP at all, using only the visible buttons | Plan, armed fault, refusal, replan and confirmation all complete; zero partial reservations. A `MutationObserver` installed before the first click records every node inserted into the tool list, so a chip that appeared and was removed again is still caught; a probe chip proves the recorder was live | `e2e/browser.mjs` |
| ENGINE-01 | Open the page in Microsoft Edge | Whatever Edge exposes, the badge matches it and a booking completes; no WebMCP means *Manual demo mode*, not an invented surface | `e2e/browser.mjs` |
| ENGINE-02 | Open the ordinary visitor flow in Firefox 155 with no WebMCP API, at 320x568 | The fallback says *Manual demo mode*; Build, review and Confirm produce one receipt with zero partial reservations, no horizontal overflow and no console error | Manual throwaway-profile smoke recorded above; not counted as an automated gate |
| QUALITY-01 | Run Lighthouse 13.4.0 three times per page in Chrome 152 with the mobile preset | The footer reports the per-page medians in category order and names the date, runner, preset and run count; it explicitly says the result is not a manual accessibility audit or certification | `test/uat/presentation.uat.test.mjs`; six JSON reports recorded outside the repository |
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
| `test/uat/presentation.uat.test.mjs` | The judge-facing hierarchy on both pages: the browser-agent prompt leads the visitor walkthrough; activity, requirements and the locked-until-review safe-failure control follow in order; shared-venue copying stays secondary; the operator's venue revision and no-half-bookings proof precede its controls; and the lift selector and empty-log contrast remain usable on a small screen |
| `test/uat/resilience.uat.test.mjs` | Log and plan growth bounds, the session limiter and its trusted-header rules, and that a restart resurrects nothing |
| `test/uat/regressions.uat.test.mjs` | One test per defect found by using the deployed app: the stale event date, the plan with no way back, the disabled control that lied, a phase label naming a control that phase hides, the refusal that erased itself, and copy claims the page could not support. These tests lock the repaired behaviour; the clean release repository does not retain discarded pre-release snapshots as reproducible Git history |
| `test/uat/map-and-operator.uat.test.mjs` | The map, and the operator page's human controls - not the operator page as a whole, whose tool surface and HTTP routes were already covered elsewhere. That the map can draw a failure at all, that it follows whichever lift the plan uses rather than one hardcoded id, that the garden route ends on the wheelchair space, that a human control exists for every lift the venue reports, and that every control whose action follows the facility selector rewrites its own label instead of naming one lift in static markup |
| `test/uat/source-hygiene.uat.test.mjs` | Properties of the source itself: no invisible control character, every script parses, no suite registers nothing. Written after a lone backslash-b inside a template literal became a real backspace six times in one session, each time silently |
| `test/uat/suite-integrity.uat.test.mjs` | Properties of the gate itself: no suite or harness binds a port written into the file, in any case of the identifier; nothing outside `test/helpers/test-server.mjs` spawns a server; that one launcher asks the OS for a port, requires its own instance token and watches its own child; and neither page decides armed state from a hardcoded lift. It asserts the architecture only - the readiness BEHAVIOUR is proved by running it, in `test-server.self.test.mjs`, because the earlier per-file text search passed on a guard referencing an undeclared binding and on four written-in ports it was reading directly |
| `test/uat/pending-fault.uat.test.mjs` | A pending venue fault is defended by the venue, not by the pages that show it: arming a second facility is refused with `OUTAGE_ALREADY_ARMED` and changes nothing, re-arming the same one is idempotent and writes no second audit line, and the invariant holds over real HTTP, which is where it was reachable |
| `test/uat/declarative-tool.uat.test.mjs` | The declarative form is a whole WebMCP tool or none at all: no shipped form carries `toolname` without `tooldescription` or the reverse, both attributes are written from one place in both directions, and the real swap is run against a DOM applying Blink's own predicate after every mutation. Written after Chrome DevTools filed kFormModelContextMissingToolDescription against the live page for a description set one statement too late; a CDP Audits probe measured 2 issues before the fix and 0 after |
| `test/uat/unsatisfiable-limits.uat.test.mjs` | A limit no route can meet is refused with the number that would work. maxDistanceM accepts from 20 m while nothing plans under the venue floor, and every value in that dead band drew the same sentence as an ordinary near-miss, so an agent was told no and not told what would be yes. The floor is measured from the venue at runtime and asserted to appear nowhere in the shipped source, because raising the published schema minimum would freeze today route data into the contract |
| `test/uat/views.uat.test.mjs` | The two page decisions that kept naming the wrong lift, as pure functions both pages and these tests import. The visitor fault control read the East outage before the armed fault, so with East out and Garden armed it offered a restore while setting aria-disabled=true - naming an action it would refuse. Every mode is now asserted to send exactly what it names, a disabled control to send nothing, and the review-to-commit fault to remain locked until a complete plan awaits confirmation. Decision-log titles resolve the facility from the entry own refs, so an arm is titled for the lift it armed and never for the other one |
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
| `test/uat/browser-outcome-envelope.uat.test.mjs` | The visible safe-failure walkthrough must not look like a broken request in Chrome DevTools. A first-party page opts into a typed `ok:false` outcome envelope, so the expected stale confirmation remains `STALE_RESOURCE_VERSION`, preserves its original status 409 and reports zero partial reservations while the HTTP exchange itself is 200. A direct API caller without that header still receives HTTP 409, so the browser presentation fix does not erase the server's raw error contract |
| `test/uat/attribution.uat.test.mjs` | Who the decision log says did a thing, and what that claim is worth. The two operator writes ignored the interaction context, so taking a lift out of service or restoring it was always filed as the venue operator whether it came from the operations page or from report_facility_outage - the one artefact this product asks to be believed was silent about half of what it records. The claim is deliberately modest: X-WebMCP-Tool is a DECLARED invocation path, not an authenticated identity, because an authorised client can send any header. A guard forbids any shipped document from calling it trusted, authenticated or proof of who acted |
| `test/helpers/test-server.self.test.mjs` | The harness proves it tested its own server; this proves the harness. Real impostor servers, real dead children, real cross-matching: a 200 with the wrong token is refused, an owned child that has already exited is refused even when a stranger echoes its token, a live child on a port serving someone else token is refused, a stopped instance stops answering on its old origin, two launches get different ports and tokens and neither validates against the other origin, and the Render-style variables are proved removed by reading back what a child would actually get |

## Expected non-2xx responses

The first-party visitor and operator pages request typed domain outcomes in a
200 response envelope, so an expected safety refusal never becomes a red Chrome
network error. Direct adversarial requests in the harness deliberately omit that
header and use a scenario-tagged allow-list for their conventional non-2xx
responses, such as a cross-role write rejection. Any other console or network
error fails the run.

## Release lesson: test the story the judge sees

The browser gate contains one named scenario that follows the recorded demo in
order: native tool discovery, `find_access_bundle`, `stage_access_bundle`, a
human confirmation overtaken by the armed East Lift fault, the visible
`STALE_RESOURCE_VERSION` refusal with zero partial reservations,
`explain_access_refusal`, `replan_access_bundle`, and the final human commit of
the Garden route. It also asserts that the first commit is a clean HTTP 200
exchange carrying domain status 409, that the second commit succeeds, and that
the whole scenario adds no failed request, console error or warning. Because
`npm run verify:all` includes the browser suite, this exact walkthrough is a
pre-deploy release gate rather than an informal manual memory.

Lessons fixed into that gate:

- Green domain tests do not prove a clean F12 console or Network panel. Expected
  business refusals need a typed first-party response envelope; raw API callers
  still keep conventional 4xx semantics.
- Tool activity is evidence of WebMCP only when the native browser tool actually
  ran. Clicking **Confirm** is deliberately recorded as human activity because
  confirmation is not and must not become a WebMCP tool.
- The activity strip shows the latest action, so the scenario captures each tool
  entry immediately before a later action legitimately replaces it.
- A browser harness must never suppress a response with a promise that cannot
  settle. Doing so poisons the page's shared refresh queue and makes unrelated
  later scenarios fail for the wrong reason.

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
2. Confirm the visitor pill reports `5 read · 1 write` on the initial
   in-app-browser surface. The declarative form tool may be absent on this host.
3. Call `get_event_access_state`; require phase `READY`, revision 1 and both lifts
   operational. Find the East route with a complete requirement set.
4. Call `stage_access_bundle` without `expectedVenueRevision`; require a readable
   `MISSING_TOOL_ARGUMENTS` refusal and no stuck call. Call it again with the
   plan id and revision 1; require `AWAITING_HUMAN_CONFIRMATION`.
5. Use the visible confirmation button. Require a receipt, phase `CONFIRMED`,
   booking `NSWR-00244`, committed revision 2, `partialReservations: 0`, focus on
   the receipt heading and a final visitor surface of `4 read · 0 write`.
6. On `/operator`, require `1 read · 2 write` on `72845b7` and call
   `get_facility_status`.
7. Report East Lift L2 out of service through the operator tool. Require revision
   3, the booking still active, no automatic cancellation or reroute, and a
   persistent disruption warning on both pages while the receipt remains visible.
8. Restore East Lift L2 through the operator tool. Require revision 4, both
   warnings cleared and the booking still confirmed.
9. Require no console errors or warnings on either page.

**This case is not automated and no gate reproduces it.** It is a manual run,
driven by hand and recorded here. The Firefox fallback in `ENGINE-02` is also a
manual check, and the Lighthouse figures in `QUALITY-01` come from reports stored
outside this repository; the shipped test guards how those scores are described,
not the measurements themselves. The remaining rows name the automated command
or browser check that asserts them. All nine checks passed on 2 September 2026
against application build `72845b7` in the ChatGPT desktop in-app browser.

What that run observed is recorded in the numbered procedure above: `5 read / 1
write` in `READY`; a readable incomplete-stage refusal; a human-confirmed East
booking `NSWR-00244` at revision 2 with `partialReservations: 0`; an operator
outage at revision 3 with persistent warnings and no automatic booking mutation;
and a restore at revision 4 with the booking still confirmed. The final
`CONFIRMED` visitor surface was `4 read / 0 write`. On application build
`72845b7`, the operator surface was `1 read / 2 write`. No console errors or
warnings were present.

That manual measurement covers the application files at `72845b7`. A later
documentation-only commit does not imply a second browser run or broaden the
evidence. Chrome results are not a substitute: ChatGPT desktop is a different
host with its own tool surface and per-call review.

## Interpretation note

Chrome's `set_access_requirements` showing **In Progress** is intentional only
when the resulting visible form is valid and waiting for the visitor to submit.
Invalid numeric input must reject and reset immediately. Omitted declarative
fields keep their visible form values; strict explicit completeness is enforced
by the imperative `find_access_bundle`, not Chrome's current form-filling layer.
