CREATE TABLE IF NOT EXISTS operation_records (
 record_id TEXT PRIMARY KEY,
 received_at TEXT NOT NULL,
 session_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence IN (1, 2)),
 mode TEXT NOT NULL,
 result TEXT NOT NULL,
 build_id TEXT NOT NULL,
 client_payload TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 signature TEXT NOT NULL,
 UNIQUE(session_id, operation_id, sequence)
);
CREATE INDEX IF NOT EXISTS operation_records_received ON operation_records(received_at);
