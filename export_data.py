#!/usr/bin/env python3
"""
Pulls rows from the Cambridge Day restaurant Google Sheet and writes them out as
data/restaurants.json for the map page to fetch.

This script is a local data-refresh tool, not part of the deployed site -- the
output JSON is what gets committed and hosted; this script and any OAuth
credentials it uses are not.

Run from this directory:
    python3 export_data.py

By default it reuses the OAuth client secret / token already set up for the
Cambridge Day Restaurants scraper (../Cambridge Day Restaurants/client_secret.json
and token.json) and the spreadsheet_id recorded in that project's
cambridgeday_state.json. Override any of these with flags if needed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_RESTAURANTS_DIR = Path(__file__).resolve().parent.parent / "Cambridge Day Restaurants"
SHEET_TAB_NAME = "Restaurants"

GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]  # match the scraper's token scope exactly,
# since both tools share the same token.json file -- a narrower scope here would
# overwrite it with a token the scraper's own write operations can't use.


def get_sheets_service(client_secrets_path: Path, token_path: Path):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    # Re-use the broader read/write token already issued for the scraper if present
    # (a read-only scope isn't a strict subset check here, but Google accepts a
    # token issued for a superset of scopes for a narrower request).
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), None)
    if not creds or not creds.valid:
        refreshed = False
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                refreshed = True
            except Exception:
                refreshed = False  # refresh token itself expired/revoked -- fall back to a fresh consent
        if not refreshed:
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets_path), GOOGLE_SCOPES)
            creds = flow.run_local_server(port=0)
        token_path.write_text(creds.to_json())

    return build("sheets", "v4", credentials=creds)


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--state-file",
        default=str(DEFAULT_RESTAURANTS_DIR / "cambridgeday_state.json"),
        help="Path to the scraper's state file (to read the spreadsheet_id).",
    )
    parser.add_argument(
        "--client-secrets",
        default=str(DEFAULT_RESTAURANTS_DIR / "client_secret.json"),
    )
    parser.add_argument(
        "--token-file",
        default=str(DEFAULT_RESTAURANTS_DIR / "token.json"),
    )
    parser.add_argument("--spreadsheet-id", default=None, help="Override the spreadsheet id directly.")
    parser.add_argument("--output", default="data/restaurants.json")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    spreadsheet_id = args.spreadsheet_id
    if not spreadsheet_id:
        state = json.loads(Path(args.state_file).read_text())
        spreadsheet_id = state["spreadsheet_id"]

    sheets_service = get_sheets_service(Path(args.client_secrets), Path(args.token_file))
    result = (
        sheets_service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"{SHEET_TAB_NAME}!A1:Z")
        .execute(num_retries=5)
    )
    rows = result.get("values", [])
    if not rows:
        print("No rows found.")
        return 1

    header = rows[0]
    col = {name: i for i, name in enumerate(header)}

    def cell(row: list[str], name: str) -> str:
        i = col.get(name)
        if i is None or i >= len(row):
            return ""
        return row[i]

    records = []
    skipped_no_coords = 0
    for row in rows[1:]:
        lat_raw = cell(row, "Latitude")
        lng_raw = cell(row, "Longitude")
        if not lat_raw or not lng_raw:
            skipped_no_coords += 1
            continue
        records.append(
            {
                "name": cell(row, "Restaurant"),
                "address": cell(row, "Address") or None,
                "excerpt": cell(row, "Excerpt") or None,
                "url": cell(row, "Article") or None,
                "date": cell(row, "Date") or None,
                "cuisine": cell(row, "Cuisine") or None,
                "lat": float(lat_raw),
                "lng": float(lng_raw),
            }
        )

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(records, indent=2))

    print(f"Wrote {len(records)} restaurants to {out_path} ({skipped_no_coords} skipped for missing coordinates).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
