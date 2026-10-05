#!/usr/bin/env python3
"""Build a historical YSCB QNH time series for the flight-path viewer."""

from __future__ import annotations

import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLIGHTS_CSV = ROOT / "yscb-rwy35-raw" / "flightpaths.csv"
OUTPUT_JSON = ROOT / "data" / "yscb-qnh.json"
IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
QNH_RE = re.compile(r"(?:^|\\s)Q(\\d{4})(?:\\s|$)")
INHG_TO_HPA = 33.8638866667


def flight_window() -> tuple[datetime, datetime]:
    minimum = None
    maximum = None
    with FLIGHTS_CSV.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                stamp = int(float(row["Timestamp"]))
            except (KeyError, TypeError, ValueError):
                continue
            dt = datetime.fromtimestamp(stamp, tz=timezone.utc)
            minimum = dt if minimum is None or dt < minimum else minimum
            maximum = dt if maximum is None or dt > maximum else maximum

    if minimum is None or maximum is None:
        raise RuntimeError("No valid timestamps found in flightpaths.csv")

    # Include observations before the first and after the last flight so every
    # ADS-B point can use the latest preceding METAR.
    return minimum - timedelta(days=1), maximum + timedelta(days=2)


def fetch_iem(start: datetime, end: datetime) -> str:
    params = [
        ("station", "YSCB"),
        ("network", "AU__ASOS"),
        ("data", "alti"),
        ("data", "metar"),
        ("year1", str(start.year)),
        ("month1", str(start.month)),
        ("day1", str(start.day)),
        ("year2", str(end.year)),
        ("month2", str(end.month)),
        ("day2", str(end.day)),
        ("tz", "Etc/UTC"),
        ("format", "onlycomma"),
        ("latlon", "no"),
        ("elev", "no"),
        ("missing", "M"),
        ("trace", "T"),
        ("direct", "no"),
        ("report_type", "3"),
        ("report_type", "4"),
    ]
    url = IEM_URL + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "flightpaths-github-pages/1.0 (+https://github.com/mejtoogood/flightpaths)"},
    )

    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read().decode("utf-8")
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)

    raise RuntimeError(f"IEM download failed after 3 attempts: {last_error}")


def parse_valid(value: str) -> datetime:
    text = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_qnh(row: dict[str, str]) -> float | None:
    metar = (row.get("metar") or "").strip()
    match = QNH_RE.search(metar)
    if match:
        return float(match.group(1))

    alti = (row.get("alti") or "").strip()
    if alti and alti != "M":
        try:
            return round(float(alti) * INHG_TO_HPA, 1)
        except ValueError:
            pass
    return None


def main() -> None:
    start, end = flight_window()
    body = fetch_iem(start, end)

    # The endpoint may include comment lines in some response modes.
    clean = "\n".join(line for line in body.splitlines() if not line.startswith("#"))
    reader = csv.DictReader(io.StringIO(clean))

    by_timestamp: dict[int, dict] = {}
    for row in reader:
        valid = (row.get("valid") or "").strip()
        if not valid:
            continue
        try:
            dt = parse_valid(valid)
        except ValueError:
            continue

        qnh = parse_qnh(row)
        if qnh is None or not 900 <= qnh <= 1100:
            continue

        timestamp = int(dt.timestamp())
        by_timestamp[timestamp] = {
            "timestamp": timestamp,
            "utc": dt.isoformat().replace("+00:00", "Z"),
            "qnhHpa": qnh,
            "metar": (row.get("metar") or "").strip(),
        }

    observations = [by_timestamp[key] for key in sorted(by_timestamp)]
    if not observations:
        raise RuntimeError("IEM returned no usable YSCB QNH observations")

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "station": "YSCB",
        "stationName": "Canberra Airport",
        "source": "Iowa Environmental Mesonet ASOS/AWOS Global METAR Archive",
        "sourceUrl": "https://mesonet.agron.iastate.edu/request/download.phtml?network=AU__ASOS",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "flightWindow": {
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": end.isoformat().replace("+00:00", "Z"),
        },
        "observations": observations,
    }
    OUTPUT_JSON.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(
        f"Wrote {len(observations)} YSCB QNH observations "
        f"from {observations[0]['utc']} to {observations[-1]['utc']}"
    )


if __name__ == "__main__":
    main()
