# No Seat Without a Route

A booking page for accessible venue seating where a seat, the route to reach it, a
working lift, the adjacent companion seat and the entrance assistance are sold as
one thing. They commit together against the same live venue revision, or nothing
commits at all.

The page is a WebMCP host. A browser agent can compare routes, assemble a plan and
rebuild it when the venue changes underneath. The final confirmation is deliberately
not a tool: the visitor presses that button.

Synthetic data. No real ticket is ever issued.

---

## The problem this is built around

Accessible seats are sold today as if a seat were a standalone product. It is not.
A wheelchair space is worthless if the lift serving it is out of order, if the
companion seat was sold separately to someone else, or if nobody scheduled the host
who opens the accessible entrance. If any link in that chain fails, the accessible
seat may become unusable even though the seat itself exists.

In the United States this is regulated rather than optional. The Justice
Department's 2010 ticketing rules require accessible seating to be sold in the
same manner, through the same channels and during the same hours as all other
seating - online included. Which rule applies depends on who runs the venue:
28 CFR 35.138 for public entities, 28 CFR 36.302(f) for public accommodations.

So the target is not "help disabled people with AI". The target is a server that
refuses to sell an incomplete promise, through **every** channel it serves: the
ordinary web form, and an agent acting for the visitor. The accessible interface
works fully on its own; WebMCP is added on top, not in place of it.

---

## Why this use case fits WebMCP

**The work is combinatorial; the decision is not.** Choosing between routes means
crossing entrances against lift status, doorway widths, travel distance, companion
seat adjacency and host availability, and redoing that whenever the venue changes.
That is exactly the labour an agent should carry. Which trade-off is acceptable —
a longer route, no companion seat, a busier foyer — is a judgement only the visitor
can make, looking at the map.

**WebMCP keeps the agent inside the decision surface.** A backend MCP server could
automate the route search too. What it would not get for free is the page the
visitor is already looking at:

1. A separate integration decides somewhere the visitor cannot see, so there is
   nothing to veto. Here, a call that prepares or changes a plan refreshes the
   map being reviewed; a read-only comparison such as `list_access_options` or
   `check_access_route` answers without repainting anything.
2. The confirmation step needs somewhere to live. No registered WebMCP tool can
   prepare or commit a booking, in any page state, so confirmation runs through
   the visible page flow. Behind that button is an ordinary same-origin HTTP
   route, and an authenticated session can reach it directly — that is outside
   the tool-surface boundary. The boundary is what is enforced; the server does
   not claim to prove a human was present.
3. A venue would otherwise build and operate agent infrastructure. This venue adds
   tool registrations to the page it already runs, reusing the same page session,
   the same application state and the same atomic server transaction as the
   visible form.

**Shared page state is the product.** The agent and the visitor are looking at one
live venue revision. Both read the same authoritative number: when it moves, the
page sees the change on its next refresh and the agent on its next tool read, and a
prepared plan built on the old number stops being confirmable.

---

## What people and agents can do together here that was hard before

A visitor's own agent can transact against live accessible inventory — comparing
routes, holding a complete plan, rebuilding it after a failure — while the visitor
keeps the final decision and can see each step land on the page.

Without a site-authored WebMCP surface, an agent must rely on general-purpose
browser actuation or a separately exposed backend integration. UI actuation is
brittle; backend integration bypasses the page. WebMCP gives the site a structured
first-party contract while keeping the resulting actions and state visible in the
same interface the visitor is using.

The specific thing this page adds: **the agent is allowed to fail correctly.** A
refusal returns any rules that failed, the revision mismatch behind it, the number
of resources that were reserved anyway (zero — the bundle commits as one write or
not at all), and which routes still work, so the agent replans instead of retrying a
call that cannot succeed. A refusal caused only by a revision change has no failed
rule to report and correctly returns an empty list.

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
`toolautosubmit`. An agent can fill it in; the visitor still submits it. The submit
handler answers with `respondWith`, so the tool call the agent started stays open
until a person presses the button and then resolves with the plan that person
produced. A host without that contract, including the ChatGPT desktop browser
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

Chrome currently fills declarative forms more loosely than the generated schema
suggests. Values outside the number inputs' published bounds are detected on
`toolactivated`, rejected through native form validation and reset before they can
leave the tool stuck. Omitted fields retain the values the visitor can see and
review; the form tool is an editor, not the strict booking command. The imperative
`find_access_bundle` remains the path that requires every requirement explicitly.

### Which tools exist depends on what the page can currently do

Registration is not static. A tool that cannot succeed in the current state is not
offered at all, which is why a confirmed booking exposes no way to change it:

| Page state and host | Read | Write | Tools |
|---|---|---|---|
| `READY` — ChatGPT desktop IAB | 5 | 1 | *derived, not measured on that host* — `find_access_bundle`, `explain_access_refusal`; imperative tools only |
| `READY` — Chrome 151 with the full declarative `SubmitEvent` contract | 5 | 2 | the same, and the form as `set_access_requirements` |
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
assume that the declarative form exists. That is why the same `READY` page reported
4 read / 1 write in the ChatGPT desktop in-app browser and 4 read / 2 write in Chrome 151, both against build `cf376a1`.

**UNKNOWN — Chrome, Edge, and desktop in-app-browser evidence are not ChatGPT
Desktop evidence.** The ChatGPT desktop row in the table above is *derived* from
the declarations for a host without the declarative form contract; it has not
been measured on that host since `cf376a1`, which predates the tools added
after it. The only figures ever measured there are the 4 / 1 above, on that
older build. *Verified against a real browser* below says what has been
measured, and on which engine.

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

### Refusals are results, not thrown errors

A tool that throws reaches the agent as an opaque browser failure: Chrome reports
it as *"The operation failed for an unknown transient reason (e.g. out of
memory)"*, which tells the agent nothing and invites it to retry a call that
cannot succeed. Every refusal here is returned as an ordinary result instead:

```json
{ "ok": false, "error": "ACTIVE_PLAN_EXISTS",
  "message": "Finish or clear the current access plan before starting another.",
  "nextAction": "CLEAR_THE_CURRENT_PLAN_OR_LET_THE_VISITOR_CONFIRM_IT",
  "activePlanId": "plan-...", "partialReservations": 0 }
```

A JSON Schema `required` list is not enforced by the browser, so the **server**
refuses an incomplete set and names what is missing. That check is in the domain
rather than in the tool wrapper, so it holds for the agent, the form and anything
else that ever calls the API. Quietly defaulting somebody's access needs is the
failure this page exists to prevent, and a guard that only ran in the browser
would not have prevented it.

One case stays opaque and cannot be fixed from the page: calling a tool that has
already been unregistered. The browser rejects that before the page sees it. A
client that re-reads the tool list, or listens for `toolchange`, never hits it;
a person clicking Run twice in the DevTools panel will.

Run `npm run evals` to print that matrix and check the whole surface against the
published authoring budgets (30-character names, 500-character descriptions,
150-character parameter descriptions, 1536-character results).

---

## Try it in 90 seconds

> **[no-seat-without-a-route.onrender.com](https://no-seat-without-a-route.onrender.com)** — no account, nothing to install.
> `npm start` gives you the same thing on `http://127.0.0.1:4173`.
>
> The venue lives in the server's memory, so a restart or redeploy empties it.
> That is a stated limit of the demo, not a fault: reopening a `?demo=` link
> after a restart tells you the venue is gone rather than showing an empty one
> as real.

No account, no setup, nothing to install beyond a browser that speaks WebMCP.

**With an agent** (ChatGPT desktop in-app browser, or Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled):

1. Open the live URL. Chrome 151 with declarative WebMCP support shows
   **5 read, 2 write**, because it also exposes the visible form. On a host
   without the declarative form contract - the ChatGPT desktop in-app browser is
   the one this was checked on - the same page is **5 read, 1 write**. That
   second figure is *derived* from the declarations, not measured: the only
   measurement ever taken on that host was 4 / 1, on build `cf376a1`, which
   predates the tools added after it. See *Verified against a real browser*.
2. Ask: *"Find a step-free plan for me and one companion. My chair is 72 cm wide,
   keep the route under 80 metres, use a quieter entrance and arrange someone to
   meet me at the door."*
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
   rule plus the routes that still work. It is registered from `READY` onward, so
   the question can also be asked about a refusal that never opened a plan.
6. Ask it to find another way in, then confirm the replacement yourself.

**Without an agent:** every step above has a button. The page is fully usable with
no WebMCP support at all — it says *Manual demo mode* and behaves like an ordinary
accessible booking form. The browser suite runs a second Chrome with the flag off
and completes that whole path by clicking: plan, armed fault, refusal, replan and
confirmation, with zero partial reservations and no tool chip anywhere.

**Two browsers, one venue:** press **Copy shared venue link** and open it anywhere
else, or open `/operator`. Both land on the same live venue, because the demo
identifier travels in the URL rather than in one browser's storage.

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

---

## Design decisions worth knowing

**One feasibility function.** The planner, the commit guard and the read-only
explanation all call `evaluateRoute`. An explanation therefore cannot claim a route
is fine while the write path rejects it.

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
authenticated endpoint, and it deliberately returns the *same* identifier when the
same still-valid plan is prepared twice — reuse keeps the confirmation map bounded.
An agent confined to the tool surface cannot confirm a booking; anything holding a
session token and speaking HTTP directly is outside that boundary.

**Requirements are functional, never medical.** The schema accepts widths, distances
and yes/no needs. Free text is rejected rather than stored — there is a test for it.

**Everything is written in one server transaction.** Route facilities are revalidated
and reservable resources change together, or the whole thing is refused. The counter
labelled *partial reservations* on the failure card is read from server state, not
hard-coded.

**A tool never cancels itself.** Before Chrome 153, unregistering a tool cancels any
execution of it still in flight. A tool that changes the page state would otherwise
kill its own call: the state change drops it from the registered set, and the abort
lands on the call that caused it. Running calls are counted, re-registration waits
for them to finish, and it happens a macrotask later so the browser sees the result
first. This applies to the declarative form too, where the browser runs the execution
itself. Both cases were found on Chrome 151, not in theory.

## Verified against a real browser

Driven through Chrome 151's own implementation — `document.modelContext.getTools()`
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
| Declarative tool fills the form | width 72 → 68; call stays open, resolves only when the visitor submits, returning the staged plan; withdrawn once the form can no longer be used |
| Declarative tool receives `0 / 0` | native validation rejects both fields, the call stops, values reset to 72 / 80, no HTTP request or plan |
| After a plan exists | `find_access_bundle` unregistered, `clear_access_plan` registered |
| Any tool that can confirm? | none |
| Lift fails during confirmation | refused, `0 partial reservations` |
| Agent asks why | `STALE_RESOURCE_VERSION`, `LIFT_OPERATIONAL`, plan revision 1 against venue revision 2, `garden-lift-route` still valid, `REPLAN` |
| Agent replans, visitor confirms | Garden Entrance route booked, revision 3, 0 partial reservations |
| Tools once the booking exists | write tools: **0** |

Also driven through **Microsoft Edge 152.0.4191.53** on 30 August 2026, in its
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

The visitor flow was also exercised by hand in the ChatGPT desktop in-app browser
**on 30 August 2026, against build `cf376a1`**. That run is manual: no automated
gate reproduces it, and no model is named, because the host exposed its browser
rather than whatever was driving it. Its `READY` surface exposed the four
read-only imperative tools plus the write-capable `find_access_bundle`:
**4 read / 1 write** on build `cf376a1`. It did not expose `set_access_requirements`, because that
host did not provide the declarative `SubmitEvent` contract used by the form. The
page reports this measured surface instead of presenting Chrome's 4 / 2 count as
universal.

The whole recovery flow completed in that host: both incomplete calls were
refused readably, the East plan was created at venue revision 1, the confirmation
after the lift failure was rejected with `STALE_RESOURCE_VERSION` and
`0 partial reservations`, the replan went through the Garden Lift, acceptance
required a visible human press, and the run finished at phase `CONFIRMED`,
revision 3, booking `NSWR-00251`, with a final surface of **4 read / 0 write** on build `cf376a1` and
no console errors. That is a measurement of `cf376a1` and of nothing later:
commits after it, up to and including `309cbed`, have no recorded run in this
host, so nothing here claims the deployed build was tested there. `QA_TEST_MATRIX.md`
carries the nine-step procedure.

## Limits, stated plainly

- The venue store is in-process and per-demo. This demonstrates a protocol pattern
  for agents; it is not a distributed booking engine.
- Two routes, one event, synthetic inventory.
- WebMCP is an experimental proposal under active change. WebKit has filed an
  opposing standards position. This page degrades to an ordinary form wherever the
  API is absent.
- `requestUserInteraction()` is not used: it is not in the live specification. The
  human step is an ordinary page button instead.
- Both roles are played by the same person in this demo. It is two role-scoped tool
  surfaces over one shared live state, not a multi-party production system.
- **There is no authentication, and the roles are not a security boundary.** A
  session asks for the role it wants and is given it; the demo identifier travels in
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

The author attests that this project was created during the submission period,
which opened on 25 August 2026. That is an attestation, not a measurement: this
repository cannot show when a file was first written. What Git records is the
commit dates described below, and those dates begin inside that window.

The log is not a feature-by-feature history and does not pretend to be. The first
commit, dated 29 August, is the whole working project in one piece — twenty files,
both tool surfaces, the eval set — because it was written in a working directory
before the repository was initialised. That, too, is the author's account rather
than something the log shows. Every commit after it is repair: each is named for
the defect it closes, and most of those defects were found by driving a real
browser rather than by reading the code. `git log --oneline` is therefore a
record of what testing found.

## License

MIT — see [LICENSE](LICENSE).
