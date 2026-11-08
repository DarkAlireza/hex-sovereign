#!/usr/bin/env python3
"""Hex Sovereign — Sample HTTP/JSON AI Agent Bot.

Plays Hex Sovereign via the documented HTTP/JSON API (works both against the local Node server
`http://localhost:8787` AND against live browser matches hosted at https://darkalireza.github.io/hex-sovereign/
via the public HTTP/JSON state relay!).

Usage:
  python sample_bot.py --url http://localhost:8787 --match HEX-DEMO --seat 1
  python sample_bot.py --cloud HEX-7K9P --seat 1
"""

import argparse
import json
import random
import time
import urllib.request


def http_json(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "HexSovereignSampleBot/1.0"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def score_move(state: dict, pid: int, move: dict) -> float:
    """Heuristic evaluator balancing Spire control, Crystal economy, Bastion defense, and combat."""
    tiles = state["tiles"]
    act = move["action"]
    if act == "end_turn":
        return -15.0

    if act == "march":
        src = tiles[move["from"]]
        dst = tiles[move["to"]]
        marching = src["units"] - 1
        forges = sum(1 for t in tiles.values() if t["owner"] == pid and t["terrain"] == "forge")
        atk = marching + (1 if forges > 0 else 0)
        dfn = dst["units"] + (2 if dst.get("bastion") else 0)
        if dst["owner"] != pid:
            if atk > dfn:
                bonus = 50.0
                if dst["terrain"] == "spire":
                    bonus += 45.0
                elif dst["terrain"] == "crystal":
                    bonus += 30.0
                elif dst["terrain"] == "forge":
                    bonus += 24.0
                if dst["owner"] is not None:
                    bonus += 20.0
                return bonus
            return -60.0
        return 15.0 if (dst["terrain"] == "spire" and dst["units"] < 5) else 2.0

    if act == "strike":
        dst = tiles[move["to"]]
        return 35.0 if (dst.get("bastion") or dst["terrain"] == "spire") else 22.0

    if act == "bastion":
        t = tiles[move["from"]]
        return 30.0 if t["terrain"] in ("spire", "crystal") else 18.0

    if act == "recruit":
        t = tiles[move["from"]]
        return 28.0 if t["units"] <= 3 else 14.0

    if act == "harvest":
        crystals = sum(1 for t in tiles.values() if t["owner"] == pid and t["terrain"] == "crystal")
        gold = state["players"][pid]["gold"]
        return 16.0 + crystals * 10.0 + (18.0 if gold < 2 else 0.0)

    return 0.0


def run_rest_bot(base_url: str, match_code: str, seat: int, name: str, auto_play_all: bool = False):
    base = base_url.rstrip("/")
    print(f"[*] Connecting to {base}/api/matches/{match_code} as {name} (seat {seat})...")
    http_json("POST", f"{base}/api/matches/{match_code}/join", {"seat": seat, "name": name, "role": "agent"})

    while True:
        data = http_json("GET", f"{base}/api/matches/{match_code}")
        state = data["state"]
        if state["status"] != "active":
            winner = state["players"][state["winner"]]["name"] if state["winner"] is not None else "Draw"
            print(f"[+] Match {match_code} finished at Round {state['round']}! Winner: {winner}")
            for p in state["players"]:
                print(f"    - {p['name']}: {p['crowns']} Crowns | {p['gold']} Gold")
            break

        turn = state["turnPlayer"]
        if turn == seat or auto_play_all:
            legal = data.get("legalMoves", [])
            if not legal:
                mv = {"action": "end_turn"}
            else:
                mv = max(legal, key=lambda m: score_move(state, turn, m) + random.uniform(0, 2.5))
            print(f"[Round {state['round']} | P{turn + 1} AP={state['apLeft']}] Submitting move: {mv.get('description', mv['action'])}")
            http_json("POST", f"{base}/api/matches/{match_code}/move", {**mv, "playerId": turn, "autoBot": not auto_play_all})
            time.sleep(0.25)
        else:
            time.sleep(0.6)


def run_cloud_relay_bot(match_code: str, seat: int, name: str):
    """Connects to a browser-hosted match at https://darkalireza.github.io/hex-sovereign/ via ntfy.sh HTTP/JSON relay."""
    topic = f"hex_sovereign_{match_code.upper().replace('-', '_')}"
    url = f"https://ntfy.sh/{topic}"
    print(f"[*] Connected to live Cloud Match {match_code} via HTTP/JSON channel {url} (Seat {seat + 1})")
    http_json("POST", url, {"kind": "join", "seat": seat, "name": name, "role": "agent"})
    last_seq = -1

    while True:
        req = urllib.request.Request(f"{url}/json?poll=1&since=all", headers={"User-Agent": "HexSovereignSampleBot/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            lines = [line.strip() for line in resp.read().decode("utf-8").splitlines() if line.strip()]

        latest_state = None
        latest_legal = []
        for line in lines:
            env = json.loads(line)
            if env.get("event") == "message":
                try:
                    msg = json.loads(env.get("message", "{}"))
                    if msg.get("kind") == "state":
                        latest_state = msg["state"]
                        latest_legal = msg.get("legalMoves", [])
                except Exception:
                    pass

        if latest_state:
            if latest_state["status"] != "active":
                print(f"[+] Cloud Match {match_code} finished! Winner: Player {latest_state['winner'] + 1}")
                break
            seq = len(latest_state.get("log", []))
            if latest_state["turnPlayer"] == seat and seq != last_seq and latest_legal:
                mv = max(latest_legal, key=lambda m: score_move(latest_state, seat, m) + random.uniform(0, 2.5))
                print(f"[Cloud Round {latest_state['round']}] Sending move: {mv.get('description', mv['action'])}")
                http_json("POST", url, {"kind": "move", "playerId": seat, "move": mv})
                last_seq = seq
        time.sleep(1.2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hex Sovereign Sample HTTP/JSON AI Agent")
    parser.add_argument("--url", default="http://localhost:8787", help="Local/hosted REST server URL")
    parser.add_argument("--match", default="HEX-DEMO", help="Match code to join")
    parser.add_argument("--seat", type=int, default=1, help="Player seat index (0..3)")
    parser.add_argument("--name", default="SampleBot-Alpha", help="Agent display name")
    parser.add_argument("--self-play", action="store_true", help="Play both seats in a full demo match")
    parser.add_argument("--cloud", metavar="MATCH_CODE", help="Join a serverless browser match via public HTTP/JSON relay")
    args = parser.parse_args()

    if args.cloud:
        run_cloud_relay_bot(args.cloud, args.seat, args.name)
    else:
        run_rest_bot(args.url, args.match, args.seat, args.name, auto_play_all=args.self_play)
