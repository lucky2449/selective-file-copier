import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ops_check', Path(__file__).with_name('ops_check.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

class OperatorCheckTests(unittest.TestCase):
    def healthy(self):
        return {'summary': {'records_24h': 3}, 'crons': ['20 18 * * *'],
                'lastMaintenance': {'status': 'success', 'finished_at': dt.datetime.now(dt.timezone.utc).isoformat()}}

    def test_empty_analytics_is_unknown(self):
        usage = ops.summarize_usage({'d1AnalyticsAdaptiveGroups': [], 'd1StorageAdaptiveGroups': [], 'workersInvocationsAdaptive': []}, 'db')
        self.assertTrue(all(value is None for value in usage.values()))

    def test_account_storage_and_log_database_are_separate(self):
        usage = ops.summarize_usage({'d1AnalyticsAdaptiveGroups': [{'sum': {'rowsRead': 10, 'rowsWritten': 2}}],
            'd1StorageAdaptiveGroups': [{'max': {'databaseSizeBytes': 11}, 'dimensions': {'databaseId': 'db'}},
            {'max': {'databaseSizeBytes': 22}, 'dimensions': {'databaseId': 'other'}}],
            'workersInvocationsAdaptive': [{'sum': {'requests': 4, 'errors': 1}}]}, 'db')
        self.assertEqual(usage['d1StorageBytes'], 33)
        self.assertEqual(usage['logDatabasePeakBytes'], 11)
        self.assertEqual(usage['workersRequests'], 4)

    def test_healthy_report_has_no_warnings(self):
        self.assertEqual(ops.warnings_for(self.healthy()), [])

    def test_gap_and_expired_and_unavailable_are_flagged(self):
        report = self.healthy() | {'gaps': [{'records': 1}], 'expiredRecords': 2, 'unavailable': ['metrics']}
        self.assertEqual(len(ops.warnings_for(report)), 3)

    def test_stale_failed_or_missing_maintenance(self):
        for last in [None, {'status': 'failed'}, {'status': 'success', 'finished_at': '2020-01-01T00:00:00Z'}]:
            self.assertEqual(len(ops.warnings_for(self.healthy() | {'lastMaintenance': last})), 1)

    def test_limits_and_probe_failure_are_flagged(self):
        report = self.healthy() | {'usage': {'workersRequests': 80000}, 'probe': {'received': False}}
        self.assertEqual(len(ops.warnings_for(report)), 2)

if __name__ == '__main__':
    unittest.main()
