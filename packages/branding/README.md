# @tramio/branding

Single source of truth for public-brand strings and identifiers (display name,
primary domain, deep-link scheme, prod/dev bundle IDs). Consumed by UI,
Catalog_Client, Entitlement_Client, and the platform-config generators.

Runtime endpoint URLs (`CATALOG_BASE_URL`, `ENTITLEMENT_BASE_URL`) are resolved
from environment-based config and are explicitly _not_ part of this module so
the primary domain can be swapped at deploy time without rebuilding non-config
source code.

Module boundary set up in task 1.3.
