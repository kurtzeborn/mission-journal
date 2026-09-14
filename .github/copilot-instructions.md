# Repository instructions

## Deployment

For ordinary application changes, use the existing GitHub Actions deployment path. Open and merge a pull request into `main`, then verify the workflow selected by the changed paths:

- `web/**` triggers **Deploy web**.
- `functions/**` triggers **Deploy functions**.
- `worker/**` triggers **Deploy email worker**.
- `infra/**` triggers **Deploy infrastructure** when its workflow permits.

Do not run a parallel manual Azure deployment or ask the user to select a subscription or region for an ordinary release. The workflows already target the established production resources. Ask for Azure context only when changing infrastructure, deployment configuration, or the production target itself.
