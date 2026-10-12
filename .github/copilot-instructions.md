# Repository instructions

## Deployment

For ordinary application changes, use the existing GitHub Actions deployment path. Open and merge a pull request into `main`, then verify the workflow selected by the changed paths:

- `web/**` triggers **Deploy web**.
- `functions/**` triggers **Deploy functions**.
- `worker/**` triggers **Deploy email worker**.
- `infra/**` triggers **Deploy infrastructure** when its workflow permits.

Do not run a parallel manual Azure deployment or ask the user to select a subscription or region for an ordinary release. The workflows already target the established production resources. Ask for Azure context only when changing infrastructure, deployment configuration, or the production target itself.

## Testing

Tests should protect observable product behavior: business rules, authorization and privacy boundaries, data transformations, failure handling, accessibility behavior, and integration seams where this application adds logic.

Do not add tests merely because code can be asserted. In particular, avoid tests that:

- freeze static copy, markup structure, CSS classes, icon choices, colors, fonts, or layout unless they express a real accessibility, security, legal, or workflow requirement;
- prove basic behavior supplied by the language, browser, Node.js, Azure, or a third-party library;
- restate constants or implementation details without exercising their user-visible effect;
- perform tautological set/get checks or duplicate coverage already provided by a stronger behavioral test.

Prefer one behavioral or table-driven test over several narrow implementation assertions. A proposed test should identify the user, operator, security, or data regression it would catch; if no meaningful regression can be named, do not add it.
