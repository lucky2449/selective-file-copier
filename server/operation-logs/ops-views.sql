-- Read-only operational views. No file data or raw request headers exposed.
CREATE VIEW IF NOT EXISTS log_ops_summary AS
SELECT count(*) AS records_24h,
 sum(CASE WHEN mode='visit' THEN 1 ELSE 0 END) AS visits_24h,
 sum(CASE WHEN sequence=1 THEN 1 ELSE 0 END) AS starts_24h,
 sum(CASE WHEN sequence=2 AND mode<>'visit' THEN 1 ELSE 0 END) AS finishes_24h,
 sum(CASE WHEN result IN ('failed','partial_failure') THEN 1 ELSE 0 END) AS failures_24h,
 sum(CASE WHEN result='cancelled' THEN 1 ELSE 0 END) AS cancelled_24h,
 max(received_at) AS last_received_at
FROM operation_records
WHERE received_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
 AND json_extract(client_payload,'$.appVersion') NOT LIKE '%-test-%'
 AND json_extract(client_payload,'$.appVersion') NOT LIKE '%-ops-%';

CREATE VIEW IF NOT EXISTS log_ops_gaps AS
SELECT 'missing_finish_after_24h' AS kind,count(*) AS records
FROM operation_records s
WHERE s.sequence=1 AND s.mode<>'visit'
 AND s.received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
 AND s.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
 AND json_extract(s.client_payload,'$.appVersion') NOT LIKE '%-test-%'
 AND json_extract(s.client_payload,'$.appVersion') NOT LIKE '%-ops-%'
 AND NOT EXISTS(SELECT 1 FROM operation_records f WHERE f.session_id=s.session_id AND f.operation_id=s.operation_id AND f.sequence=2)
UNION ALL
SELECT 'missing_start_after_10m',count(*) FROM operation_records f
WHERE f.sequence=2 AND f.mode<>'visit'
 AND f.received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')
 AND f.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
 AND json_extract(f.client_payload,'$.appVersion') NOT LIKE '%-test-%'
 AND json_extract(f.client_payload,'$.appVersion') NOT LIKE '%-ops-%'
 AND NOT EXISTS(SELECT 1 FROM operation_records s WHERE s.session_id=f.session_id AND s.operation_id=f.operation_id AND s.sequence=1);

CREATE VIEW IF NOT EXISTS log_ops_errors AS
SELECT json_extract(e.value,'$.code') AS error_code,
 json_extract(e.value,'$.phase') AS phase,
 sum(json_extract(e.value,'$.count')) AS occurrences
FROM operation_records r,json_each(r.client_payload,'$.errors') e
WHERE r.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
 AND json_extract(r.client_payload,'$.appVersion') NOT LIKE '%-test-%'
 AND json_extract(r.client_payload,'$.appVersion') NOT LIKE '%-ops-%'
GROUP BY error_code,phase;

CREATE VIEW IF NOT EXISTS log_ops_retention AS
SELECT count(*) AS expired_records FROM operation_records
WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days');
