# Shared-PC session and inspection boundary acceptance

This is the earlier checkpoint. Subsequent local connector work and its remaining
live gates are described in `inspection-single-task-live-path.md`.

Verified locally on 2026-10-04. This checkpoint preserves the completed local
changes. The immediate delivery target is one administrator's verified MES
identity and one explicitly designated inspection: save, readback, separate QC
finish, and another readback. Expansion to four inspectors is paused.

## Implemented and checked

- Browser login commits are serialized across updated tabs. Requests and draft
  recovery retain their owning login; a delayed logout cannot erase a new login.
- Inspection operations recheck signed login, current permissions, actor mapping
  and request ownership under locks before dispatch. Cached replays also check
  the current ownership of every returned inspection request.
- The optional inspector pilot is disabled by default. Configured accounts are
  confined to assigned inspections and cannot use administration, staff approval,
  legacy combined sync, or unrelated APIs. Keep configured IDs during disablement;
  deactivate and revoke sessions before removing those IDs.
- Account preparation creates inactive accounts with unusable passwords and no
  permissions. The separate role helper grants only the explicitly reviewed
  inspection permissions. Neither helper activates OAuth or issues credentials.
- Optional account activation is disabled by default. It requires an approved
  target and permission fingerprint, an administrator session with CSRF, and a
  short-lived single-use link. The account owner sets their own password. Pilot
  accounts cannot issue links. See `account-activation-release.md` for limitations.

## Evidence on the assembled source

| Check | Observed result | Private local evidence |
| --- | --- | --- |
| PostgreSQL, 22 combined labels | 559 passed, zero skipped; 25.313 seconds, completed 2026-10-04 13:44:28 UTC | `output/pg-in1/test.log` |
| Frontend Node contracts | 391 passed | `output/shared-pc-pilot-final-build-20261004.log` |
| TypeScript, Vite and legacy build | Passed | Same build log |
| React/Chrome synthetic MES flow | 6 scenarios, 34 checks | `output/shared-pc-mes-final-20261004.json` |
| React/Chrome login/session races | 10 scenarios, 177 checks | `output/shared-pc-auth-races-final-20261004.json` |
| React/Chrome assigned-inspector access | 3 scenarios, 59 checks | `output/shared-pc-pilot-browser-20261004.json` |
| Backend-served activation in Chrome | 1 synthetic scenario, 11 checks | `output/activation-chrome-2.log` |

These suites are not added together as a unique-test total. Browser providers and
accounts were synthetic. No actual MES write was performed by these checks.
The race runner recorded a browser-close timeout; its subsequent cleanup record
confirmed zero processes for that test's own profile. The activation browser used
intercepted HTTPS requests, not production TLS or production ingress logging.
Only the test-owned PostgreSQL cluster was started and stopped.

## Remaining boundary for the single-inspection target

`quality.inspection_mes_stages.get_stage_adapter()` still returns a disabled
adapter. The transport has a reviewed record-only send, but no separate finish
send. The credential vault currently permits `identity_read`, not QC operations.
This checkpoint is therefore not a working live MES inspection integration.

The next implementation must connect the same verified user's credential to
explicitly scoped reads, save and separate finish, with no inventory-token
fallback. It needs a designated target, current executor authority, independent
local review, exact historical snapshot and read/write item mapping, permanent
source test-label readback, and reviewed completion effects. The existing
reservation, login fencing and unknown-outcome reconciliation are reusable.
Neither a successful HTTP response nor local synthetic evidence proves MES
completion. Completed historical inspections are excluded.

No remote commit, deployment, production migration, live permission grant,
activation link, or live authentication enablement is included in this
checkpoint. Account preparation receipts and actual identifiers remain outside
the public repository. Four-account rollout and further UX work are paused.
