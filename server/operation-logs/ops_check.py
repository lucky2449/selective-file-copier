"""Read-only operator check, with an optional explicitly labelled synthetic probe."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import tomllib
import urllib.error
import urllib.request
import uuid

API = "https://api.cloudflare.com/client/v4/"
FREE_REFERENCE = {"workersRequests": 100000, "d1RowsRead": 5000000, "d1RowsWritten": 100000, "d1StorageBytes": 5 * 1024**3}


def request_json(url, *, data=None, headers=None):
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(), headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Network unavailable") from None


class Cloudflare:
    def __init__(self, token):
        self.headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

    def api(self, path, data=None):
        value = request_json(API + path, data=data, headers=self.headers)
        if value.get("success") is False:
            raise RuntimeError("Cloudflare API rejected request")
        return value.get("result", value)

    def graphql(self, query, variables):
        value = request_json(API + "graphql", data={"query": query, "variables": variables}, headers=self.headers)
        if value.get("errors"):
            raise RuntimeError("Cloudflare metrics unavailable or permission denied")
        return value["data"]["viewer"]["accounts"][0]


def load_token():
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        return os.environ["CLOUDFLARE_API_TOKEN"]
    if os.name == "nt":
        path = Path(os.environ["APPDATA"]) / "xdg.config/.wrangler/config/default.toml"
    else:
        path = Path.home() / ".config/.wrangler/config/default.toml"
    try:
        token = tomllib.loads(path.read_text(encoding="utf-8"))["oauth_token"]
    except (OSError, KeyError):
        raise RuntimeError("Wrangler login required: run npx wrangler login") from None
    return token


def summarize_usage(metrics, database_id):
    d1 = metrics["d1AnalyticsAdaptiveGroups"]
    storage = metrics["d1StorageAdaptiveGroups"]
    worker = metrics["workersInvocationsAdaptive"]
    # Empty analytics may mean reporting delay; never turn it into zero usage.
    return {
        "workersRequests": sum(x["sum"]["requests"] for x in worker) if worker else None,
        "workersRuntimeErrors": sum(x["sum"]["errors"] for x in worker) if worker else None,
        "d1RowsRead": sum(x["sum"]["rowsRead"] for x in d1) if d1 else None,
        "d1RowsWritten": sum(x["sum"]["rowsWritten"] for x in d1) if d1 else None,
        "d1StorageBytes": sum(x["max"]["databaseSizeBytes"] for x in storage) if storage else None,
        "logDatabasePeakBytes": next((x["max"]["databaseSizeBytes"] for x in storage if x["dimensions"]["databaseId"] == database_id), None),
    }


def warnings_for(report):
    warnings = []
    if report.get("summary", {}).get("records_24h") == 0:
        warnings.append("최근 24시간 일반 기록 없음: 방문자가 없었는지와 수집 장애를 구분하세요.")
    if any(x.get("records", 0) for x in report.get("gaps", [])):
        warnings.append("연결되지 않은 시작/종료 기록 있음: 누락 의심이며 실제 파일 작업 실패를 의미하지 않습니다.")
    if report.get("expiredRecords", 0):
        warnings.append("90일 초과 기록 있음: 다음 정리 실행과 누적 여부를 확인하세요.")
    last = report.get("lastMaintenance")
    if not last:
        warnings.append("정리 실행 이력 없음: 최초 예약 실행(한국 시간 03:20) 후 확인하세요.")
    elif last.get("status") != "success":
        warnings.append("최근 정리 작업이 성공 상태가 아닙니다.")
    elif last.get("finished_at"):
        finished = dt.datetime.fromisoformat(last["finished_at"].replace("Z", "+00:00"))
        if (dt.datetime.now(dt.timezone.utc) - finished).total_seconds() > 36 * 3600:
            warnings.append("정리 성공 이력이 36시간 이상 갱신되지 않았습니다.")
    if "20 18 * * *" not in report.get("crons", []):
        warnings.append("예약 정리 스케줄이 확인되지 않았습니다.")
    usage = report.get("usage") or {}
    for key, ceiling in FREE_REFERENCE.items():
        value = usage.get(key)
        if value is not None and value >= ceiling * 0.8:
            warnings.append(f"{key}: Free 참고 한도의 80% 이상입니다. 실제 계정 요금제/공유 사용량을 확인하세요.")
    if report.get("probe", {}).get("received") is False:
        warnings.append("수집 API 응답은 받았지만 DB 저장을 확인하지 못했습니다.")
    if usage.get("workersRuntimeErrors"):
        warnings.append("Workers 런타임 오류가 감지됐습니다. 처리된 HTTP 503 오류 수와는 별개입니다.")
    for key in report.get("unavailable", []):
        warnings.append(key + " 확인 불가: 정상/0으로 간주하지 마세요.")
    return warnings


def check(cf, config, account, endpoint, probe=False):
    database = config["d1_databases"][0]["database_id"]
    name = config["name"]
    report = {"checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "unavailable": []}
    sql = "SELECT * FROM log_ops_summary; SELECT * FROM log_ops_gaps; SELECT * FROM log_ops_errors; SELECT * FROM log_ops_retention; SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT 1;"
    rows = cf.api(f"accounts/{account}/d1/database/{database}/query", {"sql": sql, "params": []})
    report.update(summary=rows[0]["results"][0], gaps=rows[1]["results"], errors=rows[2]["results"], expiredRecords=rows[3]["results"][0]["expired_records"], lastMaintenance=next(iter(rows[4]["results"]), None))
    try:
        schedules = cf.api(f"accounts/{account}/workers/scripts/{name}/schedules")
        report["crons"] = [x["cron"] for x in (schedules if isinstance(schedules, list) else schedules.get("schedules", []))]
    except (RuntimeError, AttributeError):
        report["unavailable"].append("Cron 설정")
    now = dt.datetime.now(dt.timezone.utc)
    query = """query($account:string!,$day:Date!,$start:string!,$end:string!) {viewer {accounts(filter:{accountTag:$account}) {
      d1AnalyticsAdaptiveGroups(limit:1000,filter:{date_geq:$day,date_leq:$day}) {sum{rowsRead rowsWritten}}
      d1StorageAdaptiveGroups(limit:1000,filter:{date_geq:$day,date_leq:$day}) {max{databaseSizeBytes} dimensions{databaseId}}
      workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$start,datetime_leq:$end}) {sum{requests errors}}
    }}}"""
    try:
        metrics = cf.graphql(query, {"account": account, "day": now.date().isoformat(), "start": now.replace(hour=0,minute=0,second=0,microsecond=0).isoformat(), "end": now.isoformat()})
        report["usage"] = summarize_usage(metrics, database)
        report["usageWindow"] = "UTC 오늘 00:00부터 현재 / 계정 전체; 지연 집계, Free 한도는 참고값"
    except (RuntimeError, KeyError, IndexError):
        report["unavailable"].append("Cloudflare 사용량")
    if probe:
        value = {"schemaVersion":1,"sessionId":str(uuid.uuid4()),"operationId":str(uuid.uuid4()),"sequence":2,"clientTime":now.isoformat(timespec="milliseconds").replace("+00:00","Z"),"appVersion":"2026.10.19-ops-0","buildId":"unversioned","browser":{"name":"Other","majorVersion":"unknown"},"mode":"visit","stage":"finished","result":"visited","durationMs":0,"files":dict.fromkeys(["selected","succeeded","requested","archived","failed","unprocessed"],0),"bytes":dict.fromkeys(["selected","written","prepared"],0),"errors":[]}
        try:
            receipt = request_json(endpoint, data=value, headers={"Content-Type":"application/json","Origin":config.get("vars",{}).get("ALLOWED_ORIGIN","https://lucky2449.github.io"),"User-Agent":"Mozilla/5.0 FileMoa ops check"})
            count = cf.api(f"accounts/{account}/d1/database/{database}/query", {"sql":"SELECT count(*) AS n FROM operation_records WHERE record_id = ?", "params":[receipt["recordId"]]})[0]["results"][0]["n"]
            report["probe"] = {"received": count == 1, "synthetic": True}
        except (RuntimeError, KeyError):
            report["unavailable"].append("수집 API 실제 저장")
    report["warnings"] = warnings_for(report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true", help="Insert one labelled synthetic visit and verify persistence")
    parser.add_argument("--account")
    parser.add_argument("--endpoint", default="https://filemoa-operation-logs.lucky2449-filemoa.workers.dev/v1/operations")
    args = parser.parse_args()
    config = tomllib.loads(Path(__file__).with_name("wrangler.toml").read_text(encoding="utf-8"))
    cf = Cloudflare(load_token())
    account = args.account or config.get("account_id")
    if not account:
        accounts = cf.api("accounts")
        if len(accounts) != 1:
            raise RuntimeError("Specify --account for this deployment")
        account = accounts[0]["id"]
    report = check(cf, config, account, args.endpoint, args.probe)
    target = Path(__file__).resolve().parents[2] / ".local/log-ops-health.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    print("Report:", target)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print("Operator check failed:", str(error))
        raise SystemExit(1)
