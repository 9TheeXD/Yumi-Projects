# Yumi monorepo

## Version bump before pushing to git

Before every `git push` (or opening a PR), bump the `version` in `package.json` of every sub-project that has changes in the commits being pushed. Do this always, not optionally.

- Sub-projects: `bot`, `backend`, `frontend`, `status`, `music-web`, and any other directory with its own `package.json`.
- Only bump projects that actually changed. Leave untouched projects alone.
- Format is `MAJOR.MINOR.PATCH`. Numbers can be large (e.g. `1.234.5678`); there is no upper limit per part.
- Choose the part by judgment:
  - PATCH: bug fix, small tweak, refactor.
  - MINOR: new feature or visible behavior change.
  - MAJOR: breaking change, or only when the owner asks.
- Some services report their `version` to the status page (`bot`, `backend`). A version change there is detected by `status` as an update, so the bump must be accurate and must be deployed together with the code.
- Commit the version bump together with the change, or as its own `chore(version)` commit before the push.
