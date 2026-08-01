using './main.bicep'

param namePrefix = 'mj'

// Standard from the start. Free cannot host a managed identity, which would
// force a storage connection string into app settings. Standard is required
// by Phase 3 anyway, when Google (a custom identity provider) is added.
param staticWebAppSku = 'Standard'

// Domains a forward may legitimately arrive from during Stage 1.
param acceptedIngestDomains = 'kurtzeborn.com,gmail.com'

// Genuine missionary mail. Used for DKIM re-verification and the
// verifiedMissionary flag.
param missionaryDomains = 'missionary.org'
