// A stand-in for the part of @hatch/space-sdk that server/src/actions.ts
// uses, for the behavior tests. The SDK itself exists only inside a Muse
// Space, so CI can't install it. This is this repo's own code: nothing from
// the SDK is copied here.
//
// - defineAction: returns the definition as given. The real one differs:
//   it builds a branded object ({ __brand, request, response, handler, plus
//   description and privileged when present }), and the Space's worker finds
//   actions by that brand (Muse, reading the SDK, in its review of #38).
//   Nothing in the tests scans exports for the brand; they reach the same
//   request, response and handler fields either way. The tests validate the
//   request and response with its zod schemas themselves (see
//   actions.test.ts `call`), as the Space runtime does around a handler.
// - z: zod, the version package.json pins (the SDK re-exports it).
//
// The real SDK's types (Ctx, ActionsModule) are only imported as types by
// actions.ts, so they need nothing here. Muse's typecheck on code PRs stays
// the check against the real SDK: this stub can drift from it, and the tests
// check behavior only.

export { z } from "zod";

export function defineAction<T>(definition: T): T {
  return definition;
}
