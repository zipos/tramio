# @tramio/backend

Self-hosted Fastify backend. Implements the API surface from `design.md`:
Catalog_Service, Entitlement_Service (including License_Token issuance and
refresh), and the Moderation Store. All responses are signed with a long-lived
key whose public half is pinned in the client.

Module boundary set up in task 1.3. Implementation tracked under tasks 6.1 and 6.7.
