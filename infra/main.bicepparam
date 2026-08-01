using './main.bicep'

param namePrefix = 'mj'

// Domains a forward may legitimately arrive from during Stage 1.
param acceptedIngestDomains = 'kurtzeborn.com,gmail.com'

// Genuine missionary mail. Used for DKIM re-verification and the
// verifiedMissionary flag.
param missionaryDomains = 'missionary.org'
