# No Seat Without a Route

A booking page for accessible venue seating where the seat is planned together
with the route, a working lift, the adjacent companion seat and entrance
assistance. At confirmation, the route is revalidated and the reservable resources
commit against one live venue revision, or none of them do.

The page is a WebMCP host. A browser agent can compare routes, assemble a plan and
rebuild it when the venue changes underneath. Final confirmation is deliberately
absent from the registered WebMCP tool surface; in the demonstrated page flow it is
submitted through the visible confirmation button.

Synthetic data. No real ticket is ever issued.

**[Open the live demo](https://no-seat-without-a-route.onrender.com)** — no app
account required; the ordinary form also works without WebMCP setup.

---

## The problem this is built around

An accessible seat does not by itself prove that the journey to it will work. If
its lift is out of service, an adjacent companion seat is unavailable, or entrance
assistance is missing, the seat may be unusable even though the wheelchair space
itself exists.

Federal ADA ticketing regulations require covered public entities and public
accommodations that sell event tickets to offer accessible seating during the
same hours and through the same distribution methods as other seating. Upon
inquiry, entities that sell or distribute those tickets must describe available
accessible seating in enough detail for an individual with a disability to assess
whether a particular seating location meets their accessibility needs. Which rule
applies depends on who runs the venue:
[28 CFR § 35.138](https://www.ecfr.gov/current/title-28/chapter-I/part-35/subpart-B/section-35.138)
for public entities and
[28 CFR § 36.302(f)](https://www.ecfr.gov/current/title-28/chapter-I/part-36/subpart-C/section-36.302)
for public accommodations.

Those rules provide context; they do not require this prototype's atomic route,
live-lift and assistance model. This is a product experiment, not a claim of
legal compliance.

So the target is not "help disabled people with AI". The target is a server that
refuses to confirm an incomplete bundle through **every** channel it serves: the
ordinary web form, and an agent acting for the visitor. The accessible interface
works fully on its own; WebMCP is added on top, not in place of it.

---

## Why this use case fits WebMCP

**The work is combinatorial; the decision is not.** Choosing between routes means
crossing entrances against lift status, doorway widths, travel distance, companion
seat adjacency and host availability, and redoing that whenever the venue changes.
That is work an agent can help with. The prototype leaves route trade-offs — a
longer route, no companion seat, a busier foyer — to the visitor and keeps the map
visible while the agent compares and stages options.

**WebMCP keeps the agent inside the decision surface.** A backend MCP server could
automate the same route search, but it would not inherently share the state of the
page already open in front of the visitor:

1. Here, a call that prepares or changes a plan refreshes the map being reviewed;
   a read-only comparison such as `list_access_options` or `check_access_route`
   answers without repainting anything.
2. The confirmation step needs somewhere to live. No registered WebMCP tool can
   prepare or commit a booking, in any page state, so confirmation runs through
   the visible page flow. Behind that button is an ordinary same-origin HTTP
   route, and a client holding a valid demo session token can reach it directly —
   that is outside the tool-surface boundary. The boundary is what is enforced;
   the server does not claim to prove a human was present.
3. The venue registers tools from its existing page and reuses the same page
   session, application state and server-side bundle logic as the visible form.

**Shared page state is the product.** The agent and the visitor are looking at one
live venue revision. Both read the same authoritative number: when it moves, the
page sees the change on its next refresh and the agent on its next tool read, and a
prepared plan built on the old number stops being confirmable.

---

## What people and agents can do together here that was hard before

A visitor's own agent can work against the prototype's live synthetic inventory —
comparing routes, staging a complete plan and rebuilding it after a failure — while
plan-changing calls update the same page. The registered tool surface stops before
confirmation.

Without a site-authored WebMCP surface, an agent would typically rely on
general-purpose browser actuation or a separate backend integration. Actuation
leaves more steps open to interpretation, while a backend integration does not
inherently share the open page. WebMCP provides a structured first-party contract
and lets plan-changing actions update the interface the visitor is using.

The specific thing this page adds: **the agent is allowed to fail correctly.** In
the demonstrated stale-plan path, `explain_access_refusal` returns the revision
mismatch, any route rules that failed, the number of resources reserved anyway
(zero), and the routes that still work. The agent can replan instead of retrying a
call that cannot succeed. A refusal caused only by a revision change has no failed
route rule to report and correctly returns an empty list.

---

## How WebMCP is implemented

Both APIs are used.

**Imperative API** — twelve tools across two role-scoped surfaces, registered and
unregistered as the page state changes:

```js
await document.modelContext.registerTool({
  name: 'find_access_bundle',
  description: 'Search for one complete plan that satisfies every stated requirement at once: arrival route, working lift, wheelchair space, companion seat and entrance assistance. Every requirement must be stated explicitly. Reserves nothing.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      wheelchairWidthCm: { type: 'number', minimum: 45, maximum: 95, description: 'Width of the mobility aid in centimetres.' },
      stepFree: { type: 'boolean', description: 'True when every segment must avoid steps.' },
      /* ... */
    },
    required: ['wheelchairWidthCm', 'maxDistanceM', 'stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus'],
  },
  annotations: { readOnlyHint: false, untrustedContentHint: false },
  execute: async (requirements) => { /* reuses the same server call as the visible form */ },
});
```

**Declarative API** — on browsers that expose the complete declarative WebMCP
`SubmitEvent` contract, the visible requirements form is itself a tool, with no
`toolautosubmit`. An agent can fill it in; the visible form still has to be
submitted. The submit handler answers with `respondWith`, so the tool call the
agent started stays open until that submission and then resolves with the plan the
page produced. A host without that contract, including the ChatGPT desktop browser
tested below, receives only the imperative surface rather than a form tool it
cannot finish:

```js
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const finished = buildPlan();
  if (event.agentInvoked && event.respondWith) {
    event.respondWith(finished.then((result) => JSON.stringify(result)));
  }
});
```

```html
<form id="requirements-form"
      data-tool-name="set_access_requirements"
      data-tool-description="Update the visible access requirements form for human review. Omitted fields keep their visible values; invalid numbers are rejected. The visitor submits it. This does not book anything.">
  <input type="checkbox" name="stepFree"
         toolparamdescription="Check when every segment from street to seat must avoid steps.">
```

In the measured Chrome 152.0.7977.66 implementation, `executeTool()` could fill
values outside the inputs' published bounds. The page handles that case on
`toolactivated`, uses native validation and resets invalid values before the
invocation can remain stuck. Omitted fields retain the values the visitor can see
and review; the form tool is an editor, not the strict booking command. The
imperative `find_access_bundle` remains the path that requires every requirement
explicitly.

### Which tools exist depends on what the page can currently do

Registration is not static. A tool that cannot succeed in the current state is not
offered at all, which is why a confirmed booking exposes no way to change it:

| Page state and host | Read | Write | Tools |
|---|---|---|---|
| `READY` — ChatGPT desktop IAB | 5 | 1 | measured live on the deployed release at `2d8b5be`; imperative tools only |
| `READY` — Chrome 152 with the full declarative `SubmitEvent` contract | 5 | 2 | measured against application snapshot `a135303`; the form adds `set_access_requirements` |
| `PLAN_READY` | 4 | 2 | `stage_access_bundle`, `clear_access_plan` |
| `AWAITING_HUMAN_CONFIRMATION` | 4 | 1 | `clear_access_plan` only — nothing can confirm |
| `PLAN_STALE` | 5 | 1 | `explain_access_refusal`, `replan_access_bundle` |
| `REPLAN_READY` | 4 | 1 | `clear_access_plan`, while a replacement waits for the visitor |
| `NO_ALTERNATIVE` | 5 | 1 | `explain_access_refusal`, `clear_access_plan` |
| `CONFIRMED` | 4 | **0** | reading only; a booking cannot be altered by any tool |

On a declarative-capable browser, the form tool is withdrawn the same way: its
`toolname` attribute is removed once the form can no longer be used, so the zero in
the last row counts every tool the browser exposes, not only the imperative ones.

The status badge and individual tool chips are derived from the tools the browser
actually exposes (`document.modelContext.getTools()` where available). They do not
assume that the declarative form exists. On 2 September 2026 the deployed release
at `2d8b5be` reported **5 read / 1 write** in the ChatGPT desktop in-app browser.
The automated Chrome 152 measurement against application snapshot `a135303`
reported **5 read / 2 write**. Those two commits contain identical application
files; `2d8b5be` adds the recorded browser evidence. The host difference is the
declarative form tool, which is not counted when a host does not expose it.

The venue operations page (`/operator`) is a second surface with a different role:
`get_facility_status`, `report_facility_outage`, `restore_facility`. A visitor
session token is refused by those endpoints server-side, so the separation is
enforced by the server rather than drawn by the interface. It is not an
authorization boundary: session creation hands out whichever role it is asked
for, so these are self-asserted demo labels that the server then holds a caller
to. *Limits, stated plainly* says what a production system would add here.

Both lift states remain visible as keyboard-operable radio cards. If the venue
operator manually selects the lift used by a confirmed booking, the first click
does not change venue state: it opens an inline acknowledgement naming the
booking and the consequence, and only the explicit second step reports the
outage. An outage reported either by that page or through the operator tool does
not rewrite history: the booking remains committed, while both pages and the
operator tool expose the route disruption. This demo shows the warning but sends
no email or SMS and performs no automatic cancellation or reroute.

### Refusals are results, not opaque browser failures

Expected failures are part of the product flow, so every registered WebMCP tool
returns them as ordinary bounded results instead of throwing:

```json
{ "ok": false, "error": "ACTIVE_PLAN_EXISTS",
  "message": "Finish or clear the current access plan before starting another.",
  "nextAction": "CLEAR_THE_CURRENT_PLAN_OR_LET_THE_VISITOR_CONFIRM_IT",
  "activePlanId": "plan-..." }
```

The browser-facing wrapper validates required arguments, types, ranges and enums
before making a request. The domain repeats the completeness check for the visible
form, direct API clients and any future channel. This deliberate duplication
prevents missing access needs from being silently defaulted.

The first-party visitor and operator pages opt into a transport envelope for
expected domain refusals. The HTTP exchange is `200`, while the body remains
`ok: false` and carries the stable error code and original status; this keeps an
expected safety decision from looking like a failed network request in DevTools.
Direct API clients that do not request the envelope retain conventional 4xx
statuses, and unexpected server failures remain 5xx responses.

Once a tool has been withdrawn from the current page state, clients should refresh
the tool list or listen for `toolchange` before invoking it again.

Run `npm run evals` to print that matrix and check the whole surface against this
project's chosen budgets: 30 characters for names, 500 for tool descriptions, 150
for parameter descriptions and 1,536 for serialized results. The first three match
Chrome's current recommendations; the result cap is this project's concrete
interpretation of Chrome's approximate 1.5K guidance.

---

## Try it in 90 seconds

> **[no-seat-without-a-route.onrender.com](https://no-seat-without-a-route.onrender.com)** — no app account or package installation.
> `npm start` gives you the same thing on `http://127.0.0.1:4173`.
>
> The venue lives in the server's memory, so a restart or redeploy empties it.
> That is a stated limit of the demo, not a fault: reopening a `?demo=` link
> after a restart tells you the venue is gone rather than showing an empty one
> as real.

No app account is required. ChatGPT desktop's in-app browser needs no WebMCP setup;
Chrome testing requires enabling `chrome://flags/#enable-webmcp-testing` and
relaunching.

**With an agent** (ChatGPT desktop in-app browser, or Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled):

1. Open the live URL. Chrome 152 with declarative WebMCP support shows
   **5 read, 2 write**, because it also exposes the visible form. On a host
   without the declarative form contract - the ChatGPT desktop in-app browser is
   the one this was checked on - the same page is **5 read, 1 write**. The ChatGPT
   desktop figure was measured on deployed release `2d8b5be`; the Chrome figure
   was measured against application snapshot `a135303`. Those commits contain
   identical application files. See *Verified against a real browser* for the
   scope of each run.
2. Ask: *"Find a step-free plan for me and one companion. My chair is 72 cm wide,
   keep the route under 80 metres, use a quieter entrance and arrange entrance
   assistance. Prepare the complete plan, but let me confirm it."* Confirm that
   the page reaches `AWAITING_HUMAN_CONFIRMATION` before continuing.
   A call that prepares or changes a plan redraws the map; read-only comparisons
   leave it unchanged.
3. Press the now-enabled lift-failure button under **Break the plan during
   confirmation**. The control arms an East Lift fault for the next
   confirmation; it does not take the lift offline yet, so the plan still reads
   as ready.
4. Press **Confirm this accessible booking**.
   The server refuses: revision 1 no longer matches revision 2, and
   `0 partial reservations` is shown. Nothing was booked.
5. Ask the agent *"what happened?"* — `explain_access_refusal` returns the broken
   rule plus the routes that still work. It is offered in `READY` to explain a
   failed search, and in `PLAN_STALE` and `NO_ALTERNATIVE` to explain a blocked
   plan.
6. Ask it to find another way in, then confirm the replacement yourself.

**Without an agent:** the same failure-and-recovery path is available through the
form, buttons and visible status. With no WebMCP support, the page says *Manual
demo mode* and behaves like an ordinary accessible booking form. The browser suite
runs a second Chrome with the flag off and completes that whole path by clicking:
plan, armed fault, refusal, replan and confirmation, with zero partial reservations
and no tool chip anywhere.

**Two browsers, one venue:** press **Copy shared venue link** and open it in another
browser, or open `/operator`, while the same demo process is alive. Both join the
same in-memory venue because its identifier travels in the URL.

---

## Run locally

```bash
npm start
```

- Visitor booking: `http://127.0.0.1:4173`
- Venue operations: `http://127.0.0.1:4173/operator`

Node.js 20 or newer. No dependencies, no build step, no install.

## Verify

```bash
npm run verify
```

Runs syntax checks, the tool-surface contract and the Node test suites covering:
refusal of a stale revision, zero partial writes, deterministic replanning,
idempotent confirmation, role isolation, cross-site write rejection, data
minimisation, inherited property names used as identifiers, and — behaviourally,
against the real domain — that every tool marked `readOnlyHint` leaves the venue
byte-for-byte unchanged.

```bash
npm run test:browser
```

Drives a real Chrome over the DevTools protocol and checks that the tools register,
that the registered set follows the page state, that a refusal arrives readable, and
that the failure-and-recovery path completes with the keyboard alone — visible focus
on each control it reaches, the expected ARIA roles and live-region announcements
present, and no horizontal overflow at 320, 375, 768 or 1440 px. No screen reader is
driven, so none of this is a claim of complete nonvisual usability. `npm run verify:all` runs
everything. The adversarial cases and release gates are listed in
[QA_TEST_MATRIX.md](QA_TEST_MATRIX.md).

`evals/dataset.json` holds tool-selection cases in the shape Chrome documents for
WebMCP evals, including the failure-path case where reading the refusal is the
correct move rather than retrying. It is data, not a suite: scoring those cases
needs a model, so nothing in `npm run verify` executes them. What does run offline,
and gates the build, is the contract checker. It reads the tool definitions
themselves and fails the build on a description outside Chrome's published budget,
two tools worded identically, an undescribed or unconstrained parameter, a missing
`readOnlyHint`, or an annotation that is not in the live specification. It also
prints the per-phase tool matrix; asserting that matrix is the browser suite's job,
not its own.

The last complete release run on 2 September 2026 passed **740/740 Node checks**
and **389/389 Chrome checks** against application snapshot `a135303`. The later
`2d8b5be` commit changes only the recorded QA evidence; the application files are
identical. Exact commands, browser versions and test scope are in
[QA_TEST_MATRIX.md](QA_TEST_MATRIX.md).

---

## Design decisions worth knowing

**One feasibility function.** The planner, final route-feasibility guard and
refusal explanation all call `evaluateRoute`, so they calculate route feasibility
from the same rules. Other write preconditions — phase, revision, confirmation and
idempotency — can still reject a command for reasons unrelated to route
feasibility.

**Reads are exploratory, writes are explicit.** `list_access_options` accepts partial
requirements so an agent can browse cheaply. Booking one demands every requirement,
and the demand lives in the domain, so no channel can slip past it.

**The confirmation is not a tool, and never becomes one.** No page state registers
one. Prepared plans carry `requiresHumanConfirmation: true`, and the commit endpoint
demands a confirmation identifier that nothing on the tool surface can obtain: the
identifier is minted at `POST /api/plans/:id/prepare-confirmation`, which the page
calls from its confirm button and which no registered tool reaches.

Stated precisely, because the distinction matters: that is a boundary on the agent
surface, not a proof that a human was present. `prepare-confirmation` is an ordinary
session-scoped endpoint, and it deliberately returns the *same* identifier when the
same still-valid plan is prepared twice — reuse keeps the confirmation map bounded.
An agent confined to the tool surface cannot confirm a booking; anything holding a
session token and speaking HTTP directly is outside that boundary.

**Requirements are functional, never medical.** The schema accepts widths, distances
and yes/no needs. Free text is rejected rather than stored — there is a test for it.

**A successful booking commit is applied in one synchronous in-memory state
transition.** Route facilities are revalidated and reservable resources change
together, or the whole thing is refused. The counter labelled *partial
reservations* on the failure card is read from server state, not hard-coded.

**A tool never cancels itself.** During testing in Chrome 151, I observed that
withdrawing a tool while its execution was still in flight could cancel that
execution. The page counts running calls, waits for them to settle and applies the
new registration set in a later macrotask. The same guard covers the declarative
form. Chrome documents the underlying lifecycle change as fixed from version 153.

## Verified against a real browser

Driven against application snapshot `a135303` through Chrome 152's own
implementation — `document.modelContext.getTools()`
and `executeTool()` over the DevTools protocol, in a throwaway profile with
`chrome://flags/#enable-webmcp-testing` enabled. Every step below is a recorded
result, not a description of intent, and every one of them is asserted by
`npm run test:browser` rather than merely performed by it.

The revision numbers are those of a venue opened for the first time, which is what
you get on a fresh link. The counter is monotonic on purpose — **Reset the demo**
advances it rather than returning to 1, so that a plan identifier from before a
reset can never be revived — so a second walkthrough shows higher numbers for the
same steps. What the suite asserts across the whole run is the relationship: the
refused plan sits exactly one revision behind the venue, and the booking commits
exactly one revision past the refusal.

| Step | Result |
|---|---|
| Tools Chrome exposes on load | 6 imperative + `set_access_requirements` from the form |
| Agent reads venue state | `READY`, revision 1, both lifts operational |
| Agent compares routes for a 90 cm chair | 1 of 2 usable; the other blocked by `DOORWAY_WIDTH` |
| Declarative tool fills the form | width 72 → 68; call stays open, resolves only when the visible form is submitted, returning the staged plan; withdrawn once the form can no longer be used |
| Declarative tool receives `0 / 0` | native validation rejects both fields, the call stops, values reset to 72 / 80, no HTTP request or plan |
| After a plan exists | `find_access_bundle` unregistered, `clear_access_plan` registered |
| Any tool that can confirm? | none |
| Lift fails during confirmation | refused, `0 partial reservations` |
| Agent asks why | `STALE_RESOURCE_VERSION`, `LIFT_OPERATIONAL`, plan revision 1 against venue revision 2, `garden-lift-route` still valid, `REPLAN` |
| Agent replans, page control confirms | Garden Entrance route booked, revision 3, 0 partial reservations |
| Tools once the booking exists | write tools: **0** |

Also driven through **Microsoft Edge 152.0.4191.53** on 2 September 2026, in its
own throwaway profile over the same protocol. Edge exposes `document.modelContext`,
registers the same seven tools, reports the same **5 read · 2 write**, and completes
a booking end to end. The harness does not assume this: it records what the engine
exposes and then requires the page to match it, so an engine without WebMCP is
required to say *Manual demo mode* rather than to show a surface it does not have.
`NSWR_BROWSER=edge npm run test:browser` runs the whole suite there.

**When the server goes away.** The venue store is in-process, so a restart loses
every venue and a `?demo=` link is answered with a new empty one under the same
identifier. The page refuses to present that as the venue you were looking at: it
stops claiming the data is live, and on reload it says the venue this browser was
using is gone before showing you the replacement. A confirmation that cannot reach
the server is announced and releases the button rather than sitting on
*Confirming the whole bundle…*. All of that is in the browser suite.

The deployed visitor and operator flows were exercised by hand again in the
ChatGPT desktop in-app browser **on 2 September 2026, against deployed release
`2d8b5be`**. This is a manual, host-specific measurement; no automated gate
reproduces it. The visitor's `READY` surface exposed **5 read / 1 write**, and
this host did not expose the declarative `set_access_requirements` form tool.
The operator surface exposed **1 read / 2 write** on `2d8b5be`.

The run used the native page-defined tools to find and stage the East route. The
visible confirmation was overtaken by the armed lift fault and stopped with
`STALE_RESOURCE_VERSION` and `0 partial reservations`. The agent-facing tools then
explained the failed `LIFT_OPERATIONAL` rule and replanned through Garden Lift L4;
the replacement was committed through the visible page control. The `CONFIRMED`
visitor surface exposed **4 read / 0 write**. The operator tools then restored East
Lift L2, reported the booked Garden Lift L4 out of service and restored it. The
booking remained confirmed while the outage exposed a persistent impact warning,
which cleared after restoration. Neither page produced a console error or warning.
`QA_TEST_MATRIX.md` carries the repeatable manual procedure and the separate
automated evidence.

## Limits, stated plainly

- The venue store is in-process and per-demo. This demonstrates a protocol pattern
  for agents; it is not a distributed booking engine.
- Two routes, one event, synthetic inventory.
- WebMCP is an experimental proposal under active change. WebKit has filed an
  opposing standards position. This page degrades to an ordinary form wherever the
  API is absent.
- `requestUserInteraction()` is not used; it is not present in the 2 September
  2026 Community Group report. The human-facing step is an ordinary visible page
  button.
- Both roles are played by the same person in this demo. It is two role-scoped tool
  surfaces over one shared live state, not a multi-party production system.
- **There is no user or operator identity authentication; role-scoped demo session
  tokens are issued on request and are not an authorization boundary.** A session
  asks for the role it wants and is given it; the demo identifier travels in
  the `?demo=` link, so anyone holding that link can open the operations page and
  take a lift out of service. They can also press confirm on a plan somebody else
  prepared: a plan belongs to the venue, not to the session that made it, so the
  demo trusts everyone who has the link. What the server does enforce is that an
  *issued* visitor token cannot call operator endpoints — that check is real and
  tested. The
  part a production system would add, deciding who may claim the operator role, is
  not here. `POST /api/demo/reset` likewise needs a session but no particular role.
- The venue's two-hour lifetime, the 120-entry decision log and the session rate
  limit are demo-scale bounds chosen to keep one process honest under load, not
  capacity figures.

## Project history

This repository begins with the release snapshot committed on 1 September 2026
as `4e04f2b`: 59 tracked files containing the visitor and operator surfaces, the
server, evaluation set, automated tests and release documentation. It was
imported from a working directory, so this Git history does not claim to prove
when those files were first written.

Subsequent commits record audited corrections to that release snapshot. The
current commit list, dates and messages are available directly from
`git log --oneline`; this README deliberately does not copy a commit count that
would become stale after the next correction.

## License

MIT — see [LICENSE](LICENSE).
