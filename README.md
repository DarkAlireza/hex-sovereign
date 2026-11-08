# Hex Sovereign: Crown of the Shards

**Live Public Game URL (No Install, No Login):** [https://darkalireza.github.io/hex-sovereign/](https://darkalireza.github.io/hex-sovereign/)  
**Repository:** [https://github.com/DarkAlireza/hex-sovereign](https://github.com/DarkAlireza/hex-sovereign)

---

## Rules (In One Paragraph)
On a 19-hex tactical island surrounding a central **Crown Spire (`0,0`)**, **2 to 4 players** (humans, built-in bots, or external HTTP/JSON AI agents) compete over **12 rounds** to be the first to reach **20 Victory Crowns** (or hold the most Crowns when Round 12 ends). On your turn you spend **2 Action Points (AP)** across five interlocking actions: **March (`1 AP`)** to move `units - 1` from a controlled hex into an adjacent hex (where Attacker Power = `marching units + 1 if you hold a War Forge` vs Defender Power = `garrison + 2 if fortified with a Bastion`; conquering neutral hexes grants `+1 Crown`, enemy hexes `+2 Crowns`, and the center Spire `+3 Crowns` plus `+2 Crowns/round`); **Harvest (`1 AP`)** to collect `2 + 2 × Crystal Shards` Gold (plus `+1 Crown` if holding the Spire); **Recruit (`1 AP`, `2 Gold`)** to reinforce a hex with `+2 units` (up to 9); **Bastion (`1 AP`, `3 Gold`)** to erect a `+2 Defense` shield on a hex (`+1 Crown` immediately and `+1 Crown/round`); or **Arcane Strike (`1 AP`, `3 Gold`)** to blast an adjacent enemy garrison for `-2 units` and shatter its Bastion before marching in.

---

## Why There Is No Single Dominant Strategy
- **Aggro Rush vs. Bastion Turtle:** Blindly marching early units bounces off **Bastion** shields (`+2 Defense`), bleeding attacker forces.
- **Bastion Turtle vs. Crystal & Spire Economy:** Turtling in a corner loses the Crown race to players who **Harvest** **Crystal Shards** (`+2 Gold` each) and hold the central **Crown Spire** (`+2 Crowns/round`), funding **Arcane Strikes** that shatter Bastions.
- **Crystal Greed vs. Forge Flankers:** Spreading thin across Crystal nodes leaves 1-unit garrisons exposed to a **War Forge** controller (`+1 Attack` on every march) who sweeps undefended hexes for `+2 Crowns` per capture.

---

## How to Run Locally (Zero Dependencies)

Requires only **Node.js (>=18)** for the REST server and **Python 3** for the sample bot:

```bash
# 1. Start the HTTP/JSON game server + browser UI on http://localhost:8787
node server.js

# 2. Open http://localhost:8787 in your browser, OR run the sample Python AI agent:
python sample_bot.py --url http://localhost:8787 --match HEX-DEMO --seat 1

# 3. Run a full automated 2-agent self-play match in the terminal:
python sample_bot.py --url http://localhost:8787 --match HEX-BOTS --self-play
```

### Playing Against the Sample Bot on the Public GitHub Pages URL
You can also connect `sample_bot.py` directly to a live browser match at [https://darkalireza.github.io/hex-sovereign/](https://darkalireza.github.io/hex-sovereign/) with zero local server setup:
1. Open [https://darkalireza.github.io/hex-sovereign/](https://darkalireza.github.io/hex-sovereign/), set **Seat 2** to `External HTTP Agent`, and note the Match Code (e.g. `HEX-DEMO`).
2. Run:
   ```bash
   python sample_bot.py --cloud HEX-DEMO --seat 1
   ```

---

## HTTP/JSON Agent API Documentation

### 1. Create a Match — `POST /api/matches`
```bash
curl -s -X POST http://localhost:8787/api/matches \
  -H "Content-Type: application/json" \
  -d '{"code":"HEX-42","numPlayers":2}'
```

### 2. Read Match State & Legal Moves — `GET /api/matches/:code`
Returns the full board state (`players`, `tiles`, `round`, `turnPlayer`, `apLeft`, `log`) plus a precomputed array of `legalMoves` for the active player:
```bash
curl -s http://localhost:8787/api/matches/HEX-DEMO
```
Response excerpt:
```json
{
  "state": {
    "code": "HEX-DEMO",
    "status": "active",
    "round": 1,
    "turnPlayer": 0,
    "apLeft": 2,
    "players": [
      { "id": 0, "name": "Player 1", "role": "human", "gold": 4, "crowns": 2 },
      { "id": 1, "name": "Tactician Bot", "role": "bot", "gold": 4, "crowns": 2 }
    ]
  },
  "legalMoves": [
    { "action": "harvest", "description": "Harvest (+2 Gold)" },
    { "action": "recruit", "from": "-2,0", "description": "Recruit +2 units at (-2,0) for 2 Gold" },
    { "action": "march", "from": "-2,0", "to": "-1,0", "description": "March 3 units from (-2,0) to (-1,0)" }
  ]
}
```

### 3. Join a Match Seat — `POST /api/matches/:code/join`
```bash
curl -s -X POST http://localhost:8787/api/matches/HEX-DEMO/join \
  -H "Content-Type: application/json" \
  -d '{"seat":1,"name":"SampleBot-Alpha","role":"agent"}'
```

### 4. Submit a Move — `POST /api/matches/:code/move`
Valid `action` values: `"march"`, `"harvest"`, `"recruit"`, `"bastion"`, `"strike"`, `"end_turn"`.
```bash
curl -s -X POST http://localhost:8787/api/matches/HEX-DEMO/move \
  -H "Content-Type: application/json" \
  -d '{"playerId":0,"action":"march","from":"-2,0","to":"-1,0"}'
```

### 5. Fetch Full Match Log & Replay Snapshots — `GET /api/matches/:code/replay`
```bash
curl -s http://localhost:8787/api/matches/HEX-DEMO/replay
```
