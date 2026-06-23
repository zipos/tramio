# @tramio/storage

Storage_Manager: owns the filesystem layout under `${docs}/packs/...`, the
SQLite schema (`pack_progress`, `entitlement_cache`, `lru_access`,
`moderation_snapshot`, `device_id`, `license_tokens`), atomic stage-and-rename
write primitives, and the Offline_Pack downloader with streaming SHA-256
verification.

Module boundary set up in task 1.3. Implementation tracked under tasks 5.1–5.5.
