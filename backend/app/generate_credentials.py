from __future__ import annotations

import argparse
import json
import secrets


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operator_id", nargs="?", default="operator-17")
    parser.add_argument("role", nargs="?", choices=("agent", "supervisor"), default="supervisor")
    args = parser.parse_args()
    credentials = [{"id": args.operator_id, "role": args.role, "token": secrets.token_urlsafe(32)}]
    print(f"SESSION_SECRET={secrets.token_urlsafe(48)}")
    print(f"SUPPORT_OPERATOR_TOKENS={json.dumps(credentials, separators=(',', ':'))}")


if __name__ == "__main__":
    main()
