#!/usr/bin/env node
/**
 * Hex Sovereign — Multiplayer Turn-Based Strategy Server (Humans + HTTP/JSON AI Agents)
 * Zero external dependencies (Node.js built-in http, fs, path, crypto).
 *
 * Usage:
 *   node server.js [port]     # default port: 8787
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 8787);

// 19-hex radius-2 axial coordinate board (q, r)
const HEX_COORDS = [];
for (let q = -2; q <= 2; q++) {
  for (let r = Math.max(-2, -q - 2); r <= Math.min(2, -q + 2); r++) {
    HEX_COORDS.push([q, r]);
  }
}

const DIRS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

const START_CORNERS = [
  { key: "-2,0", name: "Crimson House", color: "#ef4444" },
  { key: "2,0", name: "Azure Syndicate", color: "#3b82f6" },
  { key: "0,-2", name: "Emerald Order", color: "#10b981" },
  { key: "0,2", name: "Amber Covenant", color: "#f59e0b" },
];

const CRYSTAL_KEYS = new Set(["-1,-1", "1,1", "-1,2", "1,-2", "0,-1", "0,1"]);
const FORGE_KEYS = new Set(["-1,0", "1,0", "-1,1", "1,-1"]);

function hexKey(q, r) {
  return `${q},${r}`;
}

function parseKey(k) {
  return k.split(",").map(Number);
}

function areAdjacent(k1, k2) {
  const [q1, r1] = parseKey(k1);
  const [q2, r2] = parseKey(k2);
  const dq = q2 - q1;
  const dr = r2 - r1;
  return DIRS.some(([oq, or]) => oq === dq && or === dr);
}

function neighborsOf(k) {
  const [q, r] = parseKey(k);
  return DIRS.map(([dq, dr]) => hexKey(q + dq, r + dr)).filter((nk) =>
    HEX_COORDS.some(([cq, cr]) => hexKey(cq, cr) === nk)
  );
}

const matches = new Map();

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "HEX-";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function createInitialMatch({ code, numPlayers = 2, seats = null } = {}) {
  const matchCode = (code || randomCode()).toUpperCase();
  const n = Math.min(4, Math.max(2, Number(numPlayers) || 2));
  const defaultSeats = [
    { name: "Player 1", role: "human" },
    { name: "Tactician Bot", role: "bot", style: "tactician" },
    { name: "Warlord Bot", role: "bot", style: "warlord" },
    { name: "Economist Bot", role: "bot", style: "economist" },
  ];

  const players = [];
  for (let i = 0; i < n; i++) {
    const s = (seats && seats[i]) || defaultSeats[i];
    players.push({
      id: i,
      name: s.name || `Player ${i + 1}`,
      role: s.role || (i === 0 ? "human" : "bot"),
      style: s.style || "tactician",
      color: START_CORNERS[i].color,
      homeKey: START_CORNERS[i].key,
      gold: 4,
      crowns: 2,
      alive: true,
    });
  }

  const tiles = {};
  for (const [q, r] of HEX_COORDS) {
    const k = hexKey(q, r);
    let terrain = "plains";
    if (k === "0,0") terrain = "spire";
    else if (CRYSTAL_KEYS.has(k)) terrain = "crystal";
    else if (FORGE_KEYS.has(k)) terrain = "forge";

    tiles[k] = {
      key: k,
      q,
      r,
      terrain,
      owner: null,
      units: terrain === "spire" ? 3 : terrain === "crystal" ? 1 : 0,
      bastion: false,
    };
  }

  for (let i = 0; i < n; i++) {
    const hk = START_CORNERS[i].key;
    tiles[hk].owner = i;
    tiles[hk].units = 4;
    tiles[hk].terrain = "citadel";
  }

  const state = {
    code: matchCode,
    status: "active",
    round: 1,
    maxRounds: 12,
    targetCrowns: 20,
    turnPlayer: 0,
    apLeft: 2,
    winner: null,
    players,
    tiles,
    log: [
      {
        seq: 0,
        round: 1,
        player: null,
        text: `Match ${matchCode} started (${n} players, target 20 Crowns or 12 rounds).`,
      },
    ],
    snapshots: [],
  };
  saveSnapshot(state);
  return state;
}

function saveSnapshot(state) {
  state.snapshots.push({
    seq: state.log.length - 1,
    round: state.round,
    turnPlayer: state.turnPlayer,
    apLeft: state.apLeft,
    players: JSON.parse(JSON.stringify(state.players)),
    tiles: JSON.parse(JSON.stringify(state.tiles)),
    note: state.log[state.log.length - 1]?.text || "",
  });
}

function countOwned(state, pid, terrainFilter = null) {
  return Object.values(state.tiles).filter(
    (t) => t.owner === pid && (!terrainFilter || t.terrain === terrainFilter)
  ).length;
}

export function computeLegalMoves(state, pid = state.turnPlayer) {
  if (state.status !== "active" || state.turnPlayer !== pid || state.apLeft <= 0) return [];
  const p = state.players[pid];
  const moves = [];

  // 1. Harvest (1 AP): gain Gold from Crystal hexes + 1 Gold base, plus +1 Crown if holding Spire
  moves.push({
    action: "harvest",
    description: `Harvest (+${2 + countOwned(state, pid, "crystal") * 2} Gold${state.tiles["0,0"].owner === pid ? ", +1 Crown from Spire" : ""})`,
  });

  // 2. Owned hex actions
  for (const t of Object.values(state.tiles)) {
    if (t.owner !== pid) continue;

    // Recruit (+2 units, costs 2 Gold, cap 9)
    if (p.gold >= 2 && t.units < 9) {
      moves.push({
        action: "recruit",
        from: t.key,
        description: `Recruit +2 units at (${t.key}) for 2 Gold`,
      });
    }

    // Bastion (costs 3 Gold, adds +2 defense shield & +1 Crown at round end)
    if (p.gold >= 3 && !t.bastion) {
      moves.push({
        action: "bastion",
        from: t.key,
        description: `Build Bastion at (${t.key}) for 3 Gold (+2 Defense, +1 Crown/round)`,
      });
    }

    // March / Attack from t.key to adjacent hexes
    if (t.units >= 2) {
      for (const nk of neighborsOf(t.key)) {
        moves.push({
          action: "march",
          from: t.key,
          to: nk,
          description: `March ${t.units - 1} units from (${t.key}) to (${nk})`,
        });
      }
    }

    // Arcane Strike (costs 3 Gold, deals 2 damage to adjacent enemy/neutral garrison)
    if (p.gold >= 3) {
      for (const nk of neighborsOf(t.key)) {
        const nt = state.tiles[nk];
        if (nt.owner !== pid && nt.units > 0) {
          moves.push({
            action: "strike",
            from: t.key,
            to: nk,
            description: `Arcane Strike (${nk}) from (${t.key}) for 3 Gold (-2 enemy units & breaks Bastion)`,
          });
        }
      }
    }
  }

  moves.push({ action: "end_turn", description: "End turn immediately" });
  return moves;
}

export function applyMove(state, move) {
  if (state.status !== "active") {
    throw new Error("Match is already finished.");
  }
  const pid = move.playerId !== undefined ? Number(move.playerId) : state.turnPlayer;
  if (pid !== state.turnPlayer) {
    throw new Error(`Not player ${pid}'s turn (current turn: ${state.turnPlayer}).`);
  }
  const p = state.players[pid];
  const act = move.action;

  if (act === "end_turn") {
    state.log.push({
      seq: state.log.length,
      round: state.round,
      player: pid,
      text: `${p.name} ended their turn.`,
    });
    advanceTurn(state);
    saveSnapshot(state);
    return state;
  }

  if (act === "harvest") {
    const crystals = countOwned(state, pid, "crystal");
    const goldGain = 2 + crystals * 2;
    p.gold += goldGain;
    let crownMsg = "";
    if (state.tiles["0,0"].owner === pid) {
      p.crowns += 1;
      crownMsg = " & +1 Crown from the Spire";
    }
    state.apLeft -= 1;
    state.log.push({
      seq: state.log.length,
      round: state.round,
      player: pid,
      text: `${p.name} harvested +${goldGain} Gold${crownMsg}.`,
    });
  } else if (act === "recruit") {
    const t = state.tiles[move.from];
    if (!t || t.owner !== pid) throw new Error("Invalid recruit tile.");
    if (p.gold < 2) throw new Error("Need 2 Gold to recruit.");
    p.gold -= 2;
    t.units = Math.min(9, t.units + 2);
    state.apLeft -= 1;
    state.log.push({
      seq: state.log.length,
      round: state.round,
      player: pid,
      text: `${p.name} recruited +2 units at (${t.key}) [now ${t.units}].`,
    });
  } else if (act === "bastion") {
    const t = state.tiles[move.from];
    if (!t || t.owner !== pid) throw new Error("Invalid bastion tile.");
    if (p.gold < 3 || t.bastion) throw new Error("Cannot build Bastion here.");
    p.gold -= 3;
    t.bastion = true;
    p.crowns += 1;
    state.apLeft -= 1;
    state.log.push({
      seq: state.log.length,
      round: state.round,
      player: pid,
      text: `${p.name} fortified (${t.key}) with a Bastion (+1 Crown, +2 Defense).`,
    });
  } else if (act === "strike") {
    const src = state.tiles[move.from];
    const dst = state.tiles[move.to];
    if (!src || !dst || src.owner !== pid || !areAdjacent(src.key, dst.key)) {
      throw new Error("Invalid Arcane Strike coordinates.");
    }
    if (p.gold < 3) throw new Error("Need 3 Gold for Arcane Strike.");
    p.gold -= 3;
    dst.units = Math.max(0, dst.units - 2);
    dst.bastion = false;
    state.apLeft -= 1;
    state.log.push({
      seq: state.log.length,
      round: state.round,
      player: pid,
      text: `${p.name} unleashed Arcane Strike on (${dst.key}) [-2 units, Bastion shattered].`,
    });
  } else if (act === "march") {
    const src = state.tiles[move.from];
    const dst = state.tiles[move.to];
    if (!src || !dst || src.owner !== pid || src.units < 2 || !areAdjacent(src.key, dst.key)) {
      throw new Error("Invalid march move.");
    }
    const marching = src.units - 1;
    src.units = 1;

    if (dst.owner === pid) {
      dst.units = Math.min(9, dst.units + marching);
      state.log.push({
        seq: state.log.length,
        round: state.round,
        player: pid,
        text: `${p.name} reinforced (${dst.key}) with ${marching} units [total ${dst.units}].`,
      });
    } else {
      const forgeBonus = countOwned(state, pid, "forge") > 0 ? 1 : 0;
      const defBonus = dst.bastion ? 2 : 0;
      const atkPower = marching + forgeBonus;
      const defPower = dst.units + defBonus;

      if (atkPower > defPower) {
        const prevOwner = dst.owner;
        dst.owner = pid;
        dst.units = Math.max(1, marching - Math.ceil(defPower * 0.6));
        dst.bastion = false;
        const crownGain = dst.terrain === "spire" ? 3 : prevOwner !== null ? 2 : 1;
        p.crowns += crownGain;
        if (dst.terrain === "crystal") p.gold += 1;
        state.log.push({
          seq: state.log.length,
          round: state.round,
          player: pid,
          text: `${p.name} conquered (${dst.key}) [${dst.terrain.toUpperCase()}] (+${crownGain} Crowns)!`,
        });
      } else {
        dst.units = Math.max(1, dst.units - Math.floor(atkPower * 0.5));
        state.log.push({
          seq: state.log.length,
          round: state.round,
          player: pid,
          text: `${p.name}'s assault on (${dst.key}) was repelled (${dst.units} defenders remain).`,
        });
      }
    }
    state.apLeft -= 1;
  } else {
    throw new Error(`Unknown action: ${act}`);
  }

  checkWinCondition(state);
  if (state.status === "active" && state.apLeft <= 0) {
    advanceTurn(state);
  }
  saveSnapshot(state);
  return state;
}

function advanceTurn(state) {
  const n = state.players.length;
  let next = (state.turnPlayer + 1) % n;
  if (next === 0) {
    // End of round scoring & upkeep
    for (const p of state.players) {
      const tilesHeld = countOwned(state, p.id);
      const bastions = Object.values(state.tiles).filter((t) => t.owner === p.id && t.bastion).length;
      const spireHeld = state.tiles["0,0"].owner === p.id ? 2 : 0;
      p.crowns += spireHeld + (tilesHeld >= 5 ? 1 : 0) + (bastions > 0 ? 1 : 0);
      p.gold += 1 + countOwned(state, p.id, "crystal");
    }
    state.round += 1;
    checkWinCondition(state);
    if (state.status !== "active") return;
  }
  state.turnPlayer = next;
  state.apLeft = 2;
}

function checkWinCondition(state) {
  for (const p of state.players) {
    if (p.crowns >= state.targetCrowns) {
      state.status = "finished";
      state.winner = p.id;
      state.log.push({
        seq: state.log.length,
        round: state.round,
        player: p.id,
        text: `VICTORY! ${p.name} reached ${p.crowns} Crowns and claimed the Spire Throne!`,
      });
      return;
    }
  }
  if (state.round > state.maxRounds) {
    state.status = "finished";
    const sorted = [...state.players].sort(
      (a, b) => b.crowns - a.crowns || countOwned(state, b.id) - countOwned(state, a.id) || b.gold - a.gold
    );
    state.winner = sorted[0].id;
    state.log.push({
      seq: state.log.length,
      round: state.maxRounds,
      player: sorted[0].id,
      text: `Round 12 complete! ${sorted[0].name} wins on Crowns (${sorted[0].crowns} Crowns)!`,
    });
  }
}

export function chooseBotMove(state) {
  const pid = state.turnPlayer;
  const p = state.players[pid];
  const legal = computeLegalMoves(state, pid);
  if (legal.length === 0) return { action: "end_turn" };

  let bestMove = legal[0];
  let bestScore = -1e9;

  for (const m of legal) {
    let score = 0;
    if (m.action === "march") {
      const src = state.tiles[m.from];
      const dst = state.tiles[m.to];
      const marching = src.units - 1;
      const forgeBonus = countOwned(state, pid, "forge") > 0 ? 1 : 0;
      const defPower = dst.units + (dst.bastion ? 2 : 0);
      if (dst.owner !== pid) {
        if (marching + forgeBonus > defPower) {
          score += 40;
          if (dst.terrain === "spire") score += 45;
          else if (dst.terrain === "crystal") score += 28;
          else if (dst.terrain === "forge") score += 24;
          if (dst.owner !== null) score += p.style === "warlord" ? 30 : 18;
        } else {
          score -= 50;
        }
      } else {
        score += dst.terrain === "spire" && dst.units < 5 ? 18 : 2;
      }
    } else if (m.action === "recruit") {
      const t = state.tiles[m.from];
      score += t.units <= 3 ? 26 : 12;
      if (t.terrain === "spire") score += 15;
    } else if (m.action === "harvest") {
      const crystals = countOwned(state, pid, "crystal");
      score += 14 + crystals * 10 + (p.gold < 2 ? 16 : 0);
      if (p.style === "economist") score += 12;
    } else if (m.action === "bastion") {
      const t = state.tiles[m.from];
      score += t.terrain === "spire" || t.terrain === "crystal" ? 28 : 16;
    } else if (m.action === "strike") {
      const dst = state.tiles[m.to];
      score += dst.bastion || dst.terrain === "spire" ? 32 : 20;
    } else if (m.action === "end_turn") {
      score = -10;
    }
    score += Math.random() * 3;
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

export function runPendingBots(state) {
  let guard = 0;
  while (state.status === "active" && state.players[state.turnPlayer]?.role === "bot" && guard < 32) {
    const mv = chooseBotMove(state);
    applyMove(state, { ...mv, playerId: state.turnPlayer });
    guard++;
  }
}

// Seed a default match HEX-DEMO for instant agent testing
matches.set("HEX-DEMO", createInitialMatch({ code: "HEX-DEMO", numPlayers: 2 }));

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // POST /api/matches — Create a new match
    if (req.method === "POST" && pathname === "/api/matches") {
      const body = await readJsonBody(req);
      const state = createInitialMatch(body);
      matches.set(state.code, state);
      if (body.autoBot !== false) runPendingBots(state);
      return sendJson(res, 201, {
        state,
        legalMoves: computeLegalMoves(state),
      });
    }

    // GET /api/matches — List active matches
    if (req.method === "GET" && pathname === "/api/matches") {
      const list = [...matches.values()].map((m) => ({
        code: m.code,
        status: m.status,
        round: m.round,
        turnPlayer: m.turnPlayer,
        players: m.players,
      }));
      return sendJson(res, 200, { matches: list });
    }

    // Match-specific endpoints: /api/matches/:code[...]
    const matchRoute = pathname.match(/^\/api\/matches\/([A-Za-z0-9-]+)(\/[a-z]+)?$/);
    if (matchRoute) {
      const code = matchRoute[1].toUpperCase();
      const sub = matchRoute[2] || "";
      let state = matches.get(code);
      if (!state && req.method === "GET") {
        state = createInitialMatch({ code, numPlayers: 2 });
        matches.set(code, state);
      }
      if (!state) return sendJson(res, 404, { error: `Match ${code} not found` });

      if (req.method === "GET" && sub === "") {
        return sendJson(res, 200, {
          state,
          legalMoves: computeLegalMoves(state),
        });
      }

      if (req.method === "GET" && sub === "/replay") {
        return sendJson(res, 200, {
          code: state.code,
          status: state.status,
          winner: state.winner,
          log: state.log,
          snapshots: state.snapshots,
        });
      }

      if (req.method === "POST" && sub === "/join") {
        const body = await readJsonBody(req);
        const seatIdx =
          body.seat !== undefined
            ? Number(body.seat)
            : state.players.findIndex((p) => p.role === "bot" || p.role === "agent");
        const targetSeat = seatIdx >= 0 && seatIdx < state.players.length ? seatIdx : 1;
        state.players[targetSeat].name = body.name || `Agent-${targetSeat + 1}`;
        state.players[targetSeat].role = body.role || "agent";
        state.log.push({
          seq: state.log.length,
          round: state.round,
          player: targetSeat,
          text: `${state.players[targetSeat].name} (${state.players[targetSeat].role}) joined seat #${targetSeat + 1}.`,
        });
        saveSnapshot(state);
        return sendJson(res, 200, {
          joinedSeat: targetSeat,
          state,
          legalMoves: computeLegalMoves(state),
        });
      }

      if (req.method === "POST" && sub === "/move") {
        const body = await readJsonBody(req);
        applyMove(state, body);
        if (body.autoBot !== false) runPendingBots(state);
        return sendJson(res, 200, {
          state,
          legalMoves: computeLegalMoves(state),
        });
      }
    }

    // Serve static files (index.html)
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  server.listen(PORT, () => {
    console.log(`Hex Sovereign server running at http://localhost:${PORT}`);
    console.log(`  Browser UI : http://localhost:${PORT}/`);
    console.log(`  Agent API  : http://localhost:${PORT}/api/matches/HEX-DEMO`);
  });
}
