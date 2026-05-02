## Summary

<!-- One paragraph: what does this change and why. -->

## Changes

<!-- Bullet list of the most important things touched. -->

-
-

## Test plan

<!--
How you verified the change. Be specific. Don't say "tested locally" — say
"started Studio, ran the Firebase create flow, watched logs, confirmed no
token leakage."
-->

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] Ran the affected flow end-to-end in the UI
- [ ]

## Security checklist (if applicable)

- [ ] No raw `console.*` calls in OAuth or credential code paths
- [ ] No secrets logged via `JSON.stringify` of credential objects
- [ ] No new endpoints exposed without auth
- [ ] Files written to disk use `0600` / `0700` modes
- [ ] N/A — change does not touch credential or auth code

## Linked issues

<!-- "Closes #123", "Related to #456". -->

## Screenshots / output

<!-- For UI changes, include before/after. For CLI changes, paste output. -->
