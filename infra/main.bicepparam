using './main.bicep'

param namePrefix = 'mj'

// Standard from the start. Free cannot host a managed identity, which would
// force a storage connection string into app settings. Standard is required
// by Phase 3 anyway, when Google (a custom identity provider) is added.
param staticWebAppSku = 'Standard'

// Domains a forward may legitimately arrive from during Stage 1.
param acceptedIngestDomains = 'pdayletters.com'

// Genuine missionary mail. Used for DKIM re-verification and the
// verifiedMissionary flag.
param missionaryDomains = 'missionary.org'

// Both of these have empty defaults in main.bicep, and an empty value is the
// safe direction there -- an unset allowlist mails nobody, and an unset
// account id cannot reach Cloudflare. That safety turns into a hazard here:
// `what-if` does not diff `siteConfig.appSettings` at all, because a GET on
// Microsoft.Web/sites does not return them. Leaving these unset made a
// deployment silently blank both, and the failure mode is outbound mail that
// stops without erroring. Verified against the live app on 2026-08-05.
//
// The account id is not a secret -- it is inert without the API token, which
// stays in Key Vault and is referenced, never valued.
param cloudflareAccountId = 'cfd16cf97da3b933b26c7e996d1c8433'

// `*` opens outbound mail to any recipient. It has to be typed on purpose,
// which is exactly what this line is.
param mailAllowlist = '*'

// Who may administer any archive in the service. Restated here for the same
// reason as the two settings above: `what-if` cannot see app settings, so an
// omitted parameter would blank this on the next deployment. That direction is
// safe -- it revokes rather than grants -- but it would revoke silently, and
// the failure would surface as the operator locked out of the archive they
// were in the middle of fixing.
//
// One name, deliberately. This list is the exception to the promise the rest
// of the service makes, and every address on it is somebody who can read any
// family's mail.
param operatorEmails = 'scott@kurtzeborn.org'

// Where credential-expiry alerts go. The same address as above, but for an
// unrelated reason -- this one is a maintenance contact, not a privilege, and
// nothing about being alerted grants any access. They are separate parameters
// so that handing operations to somebody who is not an operator, or the
// reverse, does not require touching the other.
param alertEmail = 'scott@kurtzeborn.org'
