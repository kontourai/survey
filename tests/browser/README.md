# Browser verification fixtures

`npm run test:browser` runs the full desktop/mobile suite using the normal
Playwright webServer build path. `SURVEY_PLAYWRIGHT_SKIP_BUILD=1` skips that build
only when the caller has already built the checkout.

`npm run test:browser:concurrent` builds once, runs ownership/cleanup controls,
then launches two actual Playwright processes in parallel. Each runs the existing
field-diff card assertions on desktop and mobile, with its own output directory.
The coordinator starts two Python standard-library HTTP servers on loopback port
0. Each actual server holds its OS-assigned listener from bind through cleanup;
there is no free-port check/release handoff or PID-derived probe port.

A random token, bound port and Python child PID identify each owned fixture.
The config verifies this identity in the caller and each reevaluating worker;
only this verified path omits Playwright's webServer launch. It does not enable
`reuseExistingServer`. Browser navigations assert the serving token and port,
and both expected project outcomes must reach the coordinator before success.
A foreign or mismatched endpoint fails verification. Probe failures and signals
join teardown of owned probes and servers; the Python fixture also exits on
parent-pipe EOF. Readiness and run deadlines are failures, never skipped passes.

The retained 2026-10-16 Node 22 publisher failure was a Python address-in-use
error on a PID-derived probe port. A synthetic prebound competitor reproduces
that mechanism; its identity is not evidence of the historical socket owner.
Later passing runs cannot establish that missing historical identity.
