// ===== CapNaval — serveur Node.js + ws (pour Render, pas de Durable Object) =====
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const GRID_SIZE = 12;
const MOVE_COOLDOWN_MS = 800;
const MUD_COOLDOWN_MULT = 2;
const SPEED_COOLDOWN_MULT = 0.5;
const RESIST_DAMAGE_MULT = 0.5;
const BUFF_DURATION_MS = 10000;
const ATTACK_WINDOW_MS = 12000;
const TURN_GAP_MS = 2500;
const START_HP = 100;
const RESPAWN_DELAY_MS = 4000;
const MAX_PLAYERS = 6;
const ROOM_IDLE_CLEANUP_MS = 1000 * 60 * 60 * 3;
const HILL_TICK_MS = 2000;
const HILL_CELLS = [[5, 5], [5, 6], [6, 5], [6, 6]];
const DEFAULT_TELEGRAPH_MS = 1300;
const BARREL_DAMAGE = 22;
const MAX_POWERUPS_ON_MAP = 3;
const DEFAULT_POWERUP_INTERVAL_SEC = 14;
const POWERUP_TYPES = ["heal", "resist", "speed"];
const RECONNECT_GRACE_MS = 90000; // 90s pour se reconnecter avant d'être retiré pour de bon
const SHRINK_PRESETS_SEC = { slow: 30, medium: 18, fast: 9 }; // vitesses prédéfinies
const SHRINK_MODES = ["slow", "medium", "fast", "onKO", "custom"];
const SHRINK_INITIAL_RADIUS = 6;  // couvre toute la grille 12x12 au départ
const SHRINK_MIN_RADIUS = 1;
const SHRINK_DAMAGE_PER_SEC = 6;

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#f97316"];
const TEAM_COLORS = { A: "#ef4444", B: "#3b82f6" };

const ATTACKS = [
  { id: "meteor",       name: "Météorite",         desc: "Frappe une zone 3x3 choisie",                 target: "zone", size: 3, damage: 25, telegraphMs: 1300 },
  { id: "airstrike",    name: "Frappe aérienne",   desc: "3 impacts aléatoires dans une zone 5x5",       target: "zone", size: 5, damage: 15, hits: 3, random: true, telegraphMs: 1500 },
  { id: "meteorShower", name: "Pluie de météores", desc: "5 impacts aléatoires dans une zone 6x6",       target: "zone", size: 6, damage: 14, hits: 5, random: true, telegraphMs: 2000 },
  { id: "snipe",        name: "Tir de précision",  desc: "Dégâts élevés sur une case, instantané",       target: "cell", damage: 35, instant: true },
  { id: "laser",        name: "Rayon laser",       desc: "Frappe une ligne entière, instantané",         target: "line", damage: 16, instant: true },
  { id: "shockwave",    name: "Onde de choc",      desc: "Frappe toutes les cases autour de toi",        target: "self", damage: 18, telegraphMs: 1100 },
  { id: "gunline",      name: "Rafale",            desc: "Mitraille une ligne, stoppée par les murs",   target: "line", damage: 12, telegraphMs: 1300 },
  { id: "grenade",      name: "Grenade",           desc: "Explosion sur une zone 2x2",                   target: "zone", size: 2, damage: 20, telegraphMs: 1100 },
  { id: "arrow",        name: "Flèche perforante", desc: "Transperce en ligne droite jusqu'à un mur",    target: "direction", damage: 16, distance: 12, moveSelf: false, telegraphMs: 1000 },
  { id: "charge",       name: "Charge",            desc: "Fonce en ligne droite sur 2 cases, instantané",target: "direction", damage: 22, distance: 2, moveSelf: true, instant: true },
  { id: "tornado",      name: "Tornade",           desc: "Aspire les joueurs vers le centre d'une zone 3x3", target: "zone", size: 3, damage: 10, pull: true, telegraphMs: 1300 },
  { id: "net",          name: "Filet",             desc: "Immobilise le joueur touché 3 secondes",       target: "cell", damage: 5, root: true, rootMs: 3000, telegraphMs: 1000 },
  { id: "frost",        name: "Vague de givre",    desc: "Ralentit et blesse légèrement une zone 3x3",   target: "zone", size: 3, damage: 8, slow: true, slowMs: 6000, telegraphMs: 1200 },
  { id: "mine",         name: "Piège explosif",    desc: "Pose une mine invisible sur une case",         target: "cell", damage: 30, trap: true },
  { id: "heal",         name: "Soin d'urgence",    desc: "Soigne toi ou un allié proche",                target: "ally", heal: 25 },
  { id: "shield",       name: "Bouclier",          desc: "Absorbe la prochaine attaque reçue",           target: "self", shield: true },
  { id: "poison",       name: "Zone toxique",      desc: "Nuage toxique 3x3, dégâts chaque seconde",     target: "zone", size: 3, damage: 6, poison: true, ticks: 4, telegraphMs: 1300 },
  { id: "teleport",     name: "Téléportation",     desc: "Téléporte-toi n'importe où sur la carte",      target: "cell", teleport: true, range: 999 },
];

const MODES = {
  survivor: { label: "Dernier survivant", desc: "Pas de respawn. Le dernier debout, ou la dernière équipe, gagne.", respawns: false },
  koHunt:   { label: "Chasse au K.O.",    desc: "Premier à X éliminations gagne, cumul d'équipe si activé.", respawns: true },
  kingHill: { label: "Roi de la case",    desc: "Reste sur la case centrale pour marquer des points. Premier à X points gagne.", respawns: true },
  chrono:   { label: "Chrono",            desc: "Partie limitée dans le temps. Le plus d'éliminations à la fin gagne, mort subite en cas d'égalité.", respawns: true },
};

const MAPS = {
  open:    { label: "Terrain ouvert", desc: "Aucun obstacle.",                                  walls: 0,  barrels: 0,  mud: 0 },
  ruins:   { label: "Ruines",         desc: "Des murs pour se mettre à couvert.",                walls: 14, barrels: 4,  mud: 0 },
  swamp:   { label: "Marécage",       desc: "Des flaques de boue ralentissent les déplacements.",walls: 6,  barrels: 2,  mud: 12 },
  arsenal: { label: "Arsenal",        desc: "Beaucoup de tonneaux explosifs, réaction en chaîne.",walls: 8,  barrels: 14, mud: 0 },
};

function randInt(n) { return Math.floor(Math.random() * n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE; }
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[randInt(chars.length)];
  return s;
}
function onHill(x, y) { return HILL_CELLS.some(([hx, hy]) => hx === x && hy === y); }

class Room {
  constructor(code) {
    this.code = code;
    this.status = "lobby"; // lobby | playing | ended
    this.players = {};
    this.hazards = [];
    this.powerups = [];
    this.obstacles = { walls: [], barrels: [], mud: [] };
    this.mapId = "open";
    this.powerupsEnabled = true;
    this.powerupIntervalSec = DEFAULT_POWERUP_INTERVAL_SEC;
    this.lastPowerupSpawn = 0;
    this.teamsEnabled = false;
    this.pushEnabled = true;
    this.shrinkEnabled = false;
    this.shrinkMode = "medium";
    this.shrinkIntervalSec = SHRINK_PRESETS_SEC.medium;
    this.shrinkRadius = SHRINK_INITIAL_RADIUS;
    this.lastShrinkAt = 0;
    this.isPublic = false;
    this.turn = null;
    this.hostId = null;
    this.timer = null;
    this.hillTimer = null;
    this.secondTimer = null;
    this.lastActivity = Date.now();
    this.lastAttackId = null;
    this.turnQueue = []; // "sac" de joueurs restants à faire jouer avant de remélanger
    this.pendingAttacks = new Set();

    this.mode = null;
    this.config = {};
    this.chronoEndAt = null;
    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    this.winner = null;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of Object.values(this.players)) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  publicState() {
    return {
      type: "state",
      status: this.status,
      players: Object.values(this.players).map(({ ws, clientId, disconnectedAt, ...rest }) => rest),
      hazards: this.hazards.map(h => h.type === "mine" ? { x: h.x, y: h.y, type: "mine" } : h),
      powerups: this.powerups,
      obstacles: this.obstacles,
      mapId: this.mapId,
      mapLabel: MAPS[this.mapId] ? MAPS[this.mapId].label : null,
      teamsEnabled: this.teamsEnabled,
      pushEnabled: this.pushEnabled,
      teamColors: TEAM_COLORS,
      turn: this.turn ? {
        playerId: this.turn.playerId,
        attackId: this.turn.attack.id,
        attackName: this.turn.attack.name,
        deadline: this.turn.deadline,
      } : null,
      gridSize: GRID_SIZE,
      hostId: this.hostId,
      mode: this.mode,
      modeLabel: this.mode ? MODES[this.mode].label : null,
      config: this.config,
      chronoEndAt: this.chronoEndAt,
      suddenDeath: this.suddenDeath,
      hillCells: HILL_CELLS.map(([x, y]) => ({ x, y })),
      winner: this.winner,
      isPublic: this.isPublic,
      shrink: { enabled: this.shrinkEnabled, radius: this.shrinkRadius, center: this.shrinkCenter(), mode: this.shrinkMode, intervalSec: this.shrinkIntervalSec },
    };
  }

  pushLog(message) { this.broadcast({ type: "log", message }); }

  // ---- Obstacles ----
  isWall(x, y) { return this.obstacles.walls.some(w => w.x === x && w.y === y); }
  isBarrel(x, y) { return this.obstacles.barrels.find(b => b.x === x && b.y === y) || null; }
  isMud(x, y) { return this.obstacles.mud.some(m => m.x === x && m.y === y); }
  isBlocked(x, y) { return this.isWall(x, y) || !!this.isBarrel(x, y); }

  // ---- Zone qui rétrécit (façon battle royale) ----
  shrinkCenter() { return { x: (GRID_SIZE - 1) / 2, y: (GRID_SIZE - 1) / 2 }; }
  isVoid(x, y) {
    if (!this.shrinkEnabled) return false;
    const c = this.shrinkCenter();
    const dist = Math.max(Math.abs(x - c.x), Math.abs(y - c.y));
    return dist > this.shrinkRadius;
  }

  generateMap(mapId, excludeCells) {
    const def = MAPS[mapId] || MAPS.open;
    const used = new Set((excludeCells || []).map(c => `${c.x},${c.y}`));
    const pick = () => {
      for (let tries = 0; tries < 300; tries++) {
        const x = randInt(GRID_SIZE), y = randInt(GRID_SIZE);
        const key = `${x},${y}`;
        if (!used.has(key)) { used.add(key); return { x, y }; }
      }
      return null;
    };
    const walls = [], barrels = [], mud = [];
    for (let i = 0; i < def.walls; i++) { const c = pick(); if (c) walls.push(c); }
    for (let i = 0; i < def.barrels; i++) { const c = pick(); if (c) barrels.push({ ...c, id: crypto.randomUUID() }); }
    for (let i = 0; i < def.mud; i++) { const c = pick(); if (c) mud.push(c); }
    this.obstacles = { walls, barrels, mud };
    this.mapId = MAPS[mapId] ? mapId : "open";
  }

  freeSpawn() {
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(GRID_SIZE), y = randInt(GRID_SIZE);
      const occupied = Object.values(this.players).some(p => p.alive && p.x === x && p.y === y);
      if (!occupied && !this.isBlocked(x, y) && !this.isVoid(x, y)) return { x, y };
    }
    // repli : ignore la zone dangereuse si aucune case sûre n'est trouvée
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(GRID_SIZE), y = randInt(GRID_SIZE);
      const occupied = Object.values(this.players).some(p => p.alive && p.x === x && p.y === y);
      if (!occupied && !this.isBlocked(x, y)) return { x, y };
    }
    return { x: randInt(GRID_SIZE), y: randInt(GRID_SIZE) };
  }

  // ---- Joueurs / reconnexion ----
  addPlayer(ws, pseudo, clientId) {
    if (clientId) {
      const existing = Object.values(this.players).find(p => p.clientId === clientId);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        existing.disconnectedAt = null;
        if (pseudo) existing.pseudo = pseudo;
        return existing;
      }
    }
    if (Object.keys(this.players).length >= MAX_PLAYERS) return null;
    const id = crypto.randomUUID();
    const usedColors = Object.values(this.players).map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[randInt(COLORS.length)];
    const spawn = this.freeSpawn();
    const player = {
      id, clientId: clientId || crypto.randomUUID(), pseudo, color, x: spawn.x, y: spawn.y,
      hp: START_HP, alive: true, lastMove: 0, shield: false, respawnAt: null,
      eliminations: 0, score: 0, resistUntil: null, speedUntil: null, rootedUntil: null, slowedUntil: null,
      damageDealt: 0, damageTaken: 0, timesKO: 0, team: null,
      connected: true, disconnectedAt: null, ws,
    };
    this.players[id] = player;
    if (!this.hostId) this.hostId = id;
    return player;
  }

  handleDisconnect(id) {
    const p = this.players[id];
    if (!p) return;
    if (this.status === "playing") {
      p.connected = false; p.ws = null; p.disconnectedAt = Date.now();
      this.pushLog(`${p.pseudo} est déconnecté — reconnexion possible.`);
    } else {
      this.pushLog(`${p.pseudo} a quitté la partie.`);
      delete this.players[id];
      if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null;
    }
  }

  // Départ volontaire ("Quitter") : retrait immédiat et définitif, quel que soit
  // le statut de la partie (contrairement à handleDisconnect qui garde une chance
  // de reconnexion en cas de coupure réseau pendant une partie en cours).
  removePlayerFully(id) {
    const p = this.players[id];
    if (!p) return;
    this.pushLog(`${p.pseudo} a quitté la partie.`);
    delete this.players[id];
    if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null;
    if (this.status === "playing") this.checkWinCondition();
  }

  purgeStaleDisconnected() {
    for (const [id, p] of Object.entries(this.players)) {
      if (!p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > RECONNECT_GRACE_MS) {
        this.pushLog(`${p.pseudo} a été retiré — déconnecté trop longtemps.`);
        delete this.players[id];
        if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null;
      }
    }
  }

  // ---- L'hôte termine la partie en cours et ramène tout le monde au salon ----
  abortToLobby() {
    if (this.status === "lobby") return;
    this.status = "lobby";
    this.turn = null;
    this.winner = null;
    this.hazards = [];
    this.powerups = [];
    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    if (this.timer) clearTimeout(this.timer);
    if (this.hillTimer) clearInterval(this.hillTimer);
    if (this.secondTimer) clearInterval(this.secondTimer);
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.pushLog("L'hôte a terminé la partie. Retour au salon.");
    this.broadcast(this.publicState());
  }

  // ---- Démarrage / relance ----
  start(mode, rawConfig) {
    if (this.status === "playing") return;
    // les joueurs qui n'ont jamais reconnecté depuis la partie précédente sont abandonnés
    for (const [id, p] of Object.entries(this.players)) {
      if (!p.connected) { delete this.players[id]; if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null; }
    }
    if (Object.keys(this.players).length < 1) return;
    if (!MODES[mode]) mode = "koHunt";
    rawConfig = rawConfig || {};

    const config = {};
    if (mode === "koHunt") config.targetKO = clamp(parseInt(rawConfig.targetKO) || 5, 1, 50);
    if (mode === "kingHill") config.targetScore = clamp(parseInt(rawConfig.targetScore) || 20, 1, 200);
    if (mode === "chrono") config.minutes = clamp(parseFloat(rawConfig.minutes) || 5, 1, 60);

    this.mode = mode;
    this.config = config;
    this.winner = null;
    this.hazards = [];
    this.powerups = [];
    this.lastPowerupSpawn = Date.now();
    this.powerupsEnabled = rawConfig.powerupsEnabled !== false && rawConfig.powerupsEnabled !== "false";
    this.powerupIntervalSec = clamp(parseInt(rawConfig.powerupIntervalSec) || DEFAULT_POWERUP_INTERVAL_SEC, 5, 120);
    this.teamsEnabled = rawConfig.teamsEnabled === true || rawConfig.teamsEnabled === "true";
    this.pushEnabled = rawConfig.pushEnabled !== false && rawConfig.pushEnabled !== "false";
    this.shrinkEnabled = rawConfig.shrinkEnabled === true || rawConfig.shrinkEnabled === "true";
    this.shrinkMode = SHRINK_MODES.includes(rawConfig.shrinkMode) ? rawConfig.shrinkMode : "medium";
    this.shrinkIntervalSec = this.shrinkMode === "custom"
      ? clamp(parseInt(rawConfig.shrinkIntervalSec) || 18, 3, 300)
      : (SHRINK_PRESETS_SEC[this.shrinkMode] || SHRINK_PRESETS_SEC.medium);
    this.shrinkRadius = SHRINK_INITIAL_RADIUS;
    this.lastShrinkAt = Date.now();
    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    this.lastAttackId = null;
    this.turnQueue = [];
    this.turn = null;
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();

    const hillExclude = mode === "kingHill" ? HILL_CELLS.map(([x, y]) => ({ x, y })) : [];
    this.generateMap(rawConfig.mapId, hillExclude);

    const playerList = Object.values(this.players);
    playerList.forEach((p, idx) => {
      const spawn = this.freeSpawn();
      p.hp = START_HP; p.alive = true; p.x = spawn.x; p.y = spawn.y;
      p.shield = false; p.respawnAt = null; p.resistUntil = null; p.speedUntil = null;
      p.rootedUntil = null; p.slowedUntil = null;
      p.eliminations = 0; p.score = 0; p.damageDealt = 0; p.damageTaken = 0; p.timesKO = 0;
      p.team = this.teamsEnabled ? (idx % 2 === 0 ? "A" : "B") : null;
    });

    this.status = "playing";
    if (mode === "chrono") this.chronoEndAt = Date.now() + config.minutes * 60000;
    else this.chronoEndAt = null;

    this.pushLog(`Partie lancée — mode ${MODES[mode].label} sur ${MAPS[this.mapId].label}${this.teamsEnabled ? " — par équipes" : ""} !`);
    this.broadcast(this.publicState());

    if (this.hillTimer) clearInterval(this.hillTimer);
    if (mode === "kingHill") {
      this.hillTimer = setInterval(() => this.hillTick(), HILL_TICK_MS);
      this.hillTimer.unref();
    }

    if (this.secondTimer) clearInterval(this.secondTimer);
    this.secondTimer = setInterval(() => this.secondTick(), 1000);
    this.secondTimer.unref();

    this.scheduleTick(TURN_GAP_MS);
  }

  scheduleTick(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref();
  }

  endGame(winnerIds, reason) {
    if (this.status !== "playing") return;
    this.status = "ended";
    this.winner = { ids: winnerIds, reason };
    if (this.timer) clearTimeout(this.timer);
    if (this.hillTimer) clearInterval(this.hillTimer);
    if (this.secondTimer) clearInterval(this.secondTimer);
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.turn = null;
    const names = winnerIds.map(id => this.players[id]?.pseudo).filter(Boolean);
    this.pushLog(names.length ? `Victoire de ${names.join(" et ")} !` : "Match nul — personne ne l'emporte.");
    this.broadcast(this.publicState());
  }

  checkWinCondition() {
    if (this.status !== "playing") return;
    if (this.teamsEnabled) { this.checkTeamWinCondition(); return; }
    const list = Object.values(this.players);

    if (this.mode === "survivor") {
      if (list.length > 1) {
        const alive = list.filter(p => p.alive);
        if (alive.length <= 1) { this.endGame(alive.map(p => p.id), "survivor"); return; }
      }
    } else if (this.mode === "koHunt") {
      const winner = list.find(p => p.eliminations >= this.config.targetKO);
      if (winner) { this.endGame([winner.id], "koHunt"); return; }
    } else if (this.mode === "kingHill") {
      const winner = list.find(p => p.score >= this.config.targetScore);
      if (winner) { this.endGame([winner.id], "kingHill"); return; }
    }
  }

  checkTeamWinCondition() {
    const list = Object.values(this.players);
    const teamsPresent = [...new Set(list.map(p => p.team).filter(Boolean))];

    if (this.mode === "survivor") {
      if (list.length > 1) {
        const aliveTeams = new Set(list.filter(p => p.alive).map(p => p.team));
        if (aliveTeams.size <= 1) { this.endGame(list.filter(p => aliveTeams.has(p.team)).map(p => p.id), "survivor"); return; }
      }
    } else if (this.mode === "koHunt") {
      for (const t of teamsPresent) {
        const sum = list.filter(p => p.team === t).reduce((s, p) => s + p.eliminations, 0);
        if (sum >= this.config.targetKO) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "koHunt"); return; }
      }
    } else if (this.mode === "kingHill") {
      for (const t of teamsPresent) {
        const sum = list.filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
        if (sum >= this.config.targetScore) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "kingHill"); return; }
      }
    }
  }

  // ---- Dégâts / éliminations ----
  applyDamage(attackerId, player, amount) {
    if (!player.alive) return;
    if (this.teamsEnabled && attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.team && attacker.team === player.team && attacker.id !== player.id) return; // pas de tir ami
    }
    if (player.shield) { player.shield = false; this.pushLog(`${player.pseudo} bloque l'attaque avec son bouclier !`); return; }
    if (player.resistUntil && Date.now() < player.resistUntil) amount = Math.round(amount * RESIST_DAMAGE_MULT);
    amount = Math.max(0, Math.round(amount));
    player.hp = clamp(player.hp - amount, 0, START_HP);
    player.damageTaken += amount;
    if (attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.id !== player.id) attacker.damageDealt += amount;
    }
    if (player.hp === 0) this.onElimination(attackerId, player);
  }
  applyHeal(player, amount) { if (player.alive) player.hp = clamp(player.hp + amount, 0, START_HP); }

  onElimination(attackerId, victim) {
    victim.alive = false;
    victim.timesKO += 1;
    this.pushLog(`${victim.pseudo} est K.O. !`);

    if (this.shrinkEnabled && this.shrinkMode === "onKO" && this.shrinkRadius > SHRINK_MIN_RADIUS) {
      this.shrinkRadius -= 1;
      this.lastShrinkAt = Date.now();
      this.pushLog("⚠️ La zone se rétrécit !");
    }

    const attacker = attackerId ? this.players[attackerId] : null;
    if (attacker && attacker.id !== victim.id) attacker.eliminations += 1;

    if (this.suddenDeath && attacker && this.suddenDeathIds.has(attacker.id)) {
      const winners = this.teamsEnabled && attacker.team
        ? Object.values(this.players).filter(p => p.team === attacker.team).map(p => p.id)
        : [attacker.id];
      this.endGame(winners, "suddenDeath");
      return;
    }

    const respawns = MODES[this.mode] ? MODES[this.mode].respawns : true;
    victim.respawnAt = respawns ? Date.now() + RESPAWN_DELAY_MS : null;

    this.checkWinCondition();
  }

  cellsForZone(anchorX, anchorY, size) {
    const half = Math.floor(size / 2);
    const cells = [];
    for (let dx = -half; dx <= size - 1 - half; dx++) {
      for (let dy = -half; dy <= size - 1 - half; dy++) {
        const x = anchorX + dx, y = anchorY + dy;
        if (inBounds(x, y)) cells.push({ x, y });
      }
    }
    return cells;
  }

  // ---- Bonus au sol ----
  applyPowerup(player, type) {
    if (type === "heal") { this.applyHeal(player, 30); this.pushLog(`${player.pseudo} récupère un bonus de vie !`); }
    else if (type === "resist") { player.resistUntil = Date.now() + BUFF_DURATION_MS; this.pushLog(`${player.pseudo} récupère un bonus de résistance !`); }
    else if (type === "speed") { player.speedUntil = Date.now() + BUFF_DURATION_MS; this.pushLog(`${player.pseudo} récupère un bonus de vitesse !`); }
  }

  checkPowerupPickup(player, x, y) {
    const idx = this.powerups.findIndex(pu => pu.x === x && pu.y === y);
    if (idx < 0) return;
    const pu = this.powerups[idx];
    this.powerups.splice(idx, 1);
    this.applyPowerup(player, pu.type);
  }

  checkMineTrigger(player, x, y) {
    const mineIdx = this.hazards.findIndex(h => h.type === "mine" && h.x === x && h.y === y);
    if (mineIdx < 0) return;
    const mine = this.hazards[mineIdx];
    this.hazards.splice(mineIdx, 1);
    this.applyDamage(mine.ownerId, player, mine.damage || 30);
    this.pushLog(`${player.pseudo} a déclenché un piège explosif !`);
  }

  // ---- Tonneaux : explosion en chaîne ----
  triggerBarrelChain(attackerId, startCells) {
    const hitPlayerAt = (x, y) => Object.values(this.players).find(p => p.alive && p.x === x && p.y === y);
    const queue = startCells.slice();
    const extra = [];
    const exploded = new Set();
    let guard = 0;
    while (queue.length && guard < 200) {
      guard++;
      const c = queue.shift();
      const barrel = this.isBarrel(c.x, c.y);
      if (!barrel || exploded.has(barrel.id)) continue;
      exploded.add(barrel.id);
      this.obstacles.barrels = this.obstacles.barrels.filter(b => b.id !== barrel.id);
      this.pushLog("Un tonneau explose !");
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const bx = c.x + dx, by = c.y + dy;
        if (!inBounds(bx, by)) continue;
        extra.push({ x: bx, y: by });
        const bp = hitPlayerAt(bx, by);
        if (bp) this.applyDamage(attackerId, bp, BARREL_DAMAGE);
        if (this.isBarrel(bx, by)) queue.push({ x: bx, y: by });
      }
    }
    return extra;
  }

  // ---- Déplacement (avec poussée des autres joueurs) ----
  handleMove(player, msg) {
    if (!player.alive) return;
    const now = Date.now();
    if (player.rootedUntil && now < player.rootedUntil) return; // immobilisé par un Filet
    let cooldown = MOVE_COOLDOWN_MS;
    if (this.isMud(player.x, player.y)) cooldown *= MUD_COOLDOWN_MULT;
    if (player.slowedUntil && now < player.slowedUntil) cooldown *= MUD_COOLDOWN_MULT; // ralenti par la Vague de givre
    if (player.speedUntil && now < player.speedUntil) cooldown = Math.round(cooldown * SPEED_COOLDOWN_MULT);
    if (now - player.lastMove < cooldown) return;

    const { x, y } = msg;
    if (typeof x !== "number" || typeof y !== "number" || !inBounds(x, y)) return;
    const dx = x - player.x, dy = y - player.y;
    if (!((Math.abs(dx) === 1 && dy === 0) || (dx === 0 && Math.abs(dy) === 1))) return;
    if (this.isBlocked(x, y)) return;

    const occupant = Object.values(this.players).find(p => p.alive && p.id !== player.id && p.x === x && p.y === y);
    if (occupant) {
      if (!this.pushEnabled) return; // poussée désactivée : la case est infranchissable, comme un mur
      const pushX = x + dx, pushY = y + dy;
      const pushBlocked = !inBounds(pushX, pushY) || this.isBlocked(pushX, pushY) ||
        Object.values(this.players).some(p => p.alive && p.id !== occupant.id && p.x === pushX && p.y === pushY);
      if (pushBlocked) return;
      occupant.x = pushX; occupant.y = pushY;
      this.pushLog(`${player.pseudo} pousse ${occupant.pseudo} !`);
      this.checkMineTrigger(occupant, pushX, pushY);
    }

    player.x = x; player.y = y; player.lastMove = now;
    this.checkMineTrigger(player, x, y);
    this.checkPowerupPickup(player, x, y);

    this.broadcast(this.publicState());
  }

  handleAttack(player, msg) {
    const turn = this.turn;
    if (!turn || turn.playerId !== player.id) return;
    if (Date.now() > turn.deadline) return;
    const attack = turn.attack;
    this.turn = null;

    const isDelayed = !!attack.damage && !attack.trap && !attack.instant;

    if (!isDelayed) {
      const affected = this.resolveAttackEffects(player, attack, msg, null);
      this.pushLog(`${player.pseudo} utilise ${attack.name} !`);
      this.broadcast({ type: "attackResolved", attackId: attack.id, by: player.id, cells: affected });
    } else {
      const cells = this.computeAttackCells(player, attack, msg);
      const delay = attack.telegraphMs || DEFAULT_TELEGRAPH_MS;
      const resolveAt = Date.now() + delay;
      this.pushLog(`${player.pseudo} prépare ${attack.name} !`);
      this.broadcast({ type: "telegraph", attackId: attack.id, by: player.id, cells, resolveAt });

      const handle = setTimeout(() => {
        this.pendingAttacks.delete(handle);
        if (this.status !== "playing") return;
        const liveAttacker = this.players[player.id];
        if (!liveAttacker) return;
        const affected = this.resolveAttackEffects(liveAttacker, attack, msg, cells);
        this.broadcast({ type: "attackResolved", attackId: attack.id, by: liveAttacker.id, cells: affected });
        this.broadcast(this.publicState());
      }, delay);
      if (handle.unref) handle.unref();
      this.pendingAttacks.add(handle);
    }

    this.broadcast(this.publicState());
    if (this.status === "playing") this.scheduleTick(TURN_GAP_MS);
  }

  computeAttackCells(player, attack, msg) {
    if (attack.target === "zone" && attack.random) {
      const zone = this.cellsForZone(msg.x, msg.y, attack.size);
      const picks = [];
      for (let i = 0; i < (attack.hits || 1); i++) picks.push(zone[randInt(zone.length)]);
      return picks;
    }
    if (attack.target === "zone") {
      return this.cellsForZone(msg.x, msg.y, attack.size);
    }
    if (attack.target === "cell") {
      return inBounds(msg.x, msg.y) ? [{ x: msg.x, y: msg.y }] : [];
    }
    if (attack.target === "self") {
      const cells = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = player.x + dx, y = player.y + dy;
        if (inBounds(x, y)) cells.push({ x, y });
      }
      return cells;
    }
    if (attack.target === "line") {
      // rayon dans les deux sens depuis la case choisie, stoppé par les murs
      const axis = msg.axis === "col" ? "col" : "row";
      const step = axis === "row" ? [1, 0] : [0, 1];
      const cells = [{ x: msg.x, y: msg.y }];
      let cx = msg.x, cy = msg.y;
      while (true) {
        const nx = cx + step[0], ny = cy + step[1];
        if (!inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      cx = msg.x; cy = msg.y;
      while (true) {
        const nx = cx - step[0], ny = cy - step[1];
        if (!inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      return cells;
    }
    if (attack.target === "direction") {
      const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const d = dirs[msg.dir] || [0, 0];
      let cx = player.x, cy = player.y;
      const cells = [];
      const maxSteps = attack.distance || GRID_SIZE;
      for (let step = 0; step < maxSteps; step++) {
        const nx = cx + d[0], ny = cy + d[1];
        if (!inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cx = nx; cy = ny;
        cells.push({ x: cx, y: cy });
      }
      return cells;
    }
    return [];
  }

  resolveAttackEffects(player, attack, msg, precomputedCells) {
    const hitPlayerAt = (x, y) => Object.values(this.players).find(p => p.alive && p.x === x && p.y === y);

    if (precomputedCells) {
      const originalCells = precomputedCells.slice();
      for (const c of originalCells) {
        const hitP = hitPlayerAt(c.x, c.y);
        if (!hitP) continue;
        if (attack.damage) this.applyDamage(player.id, hitP, attack.damage);
        if (attack.root && hitP.alive) hitP.rootedUntil = Date.now() + (attack.rootMs || 3000);
        if (attack.slow && hitP.alive) hitP.slowedUntil = Date.now() + (attack.slowMs || 6000);
      }

      // Tornade : aspire chaque joueur touché d'une case vers le centre de la zone
      if (attack.pull) {
        for (const c of originalCells) {
          const hitP = hitPlayerAt(c.x, c.y);
          if (!hitP) continue;
          const dx = Math.sign(msg.x - hitP.x), dy = Math.sign(msg.y - hitP.y);
          const nx = hitP.x + dx, ny = hitP.y + dy;
          const blocked = !inBounds(nx, ny) || this.isBlocked(nx, ny) ||
            Object.values(this.players).some(pp => pp.alive && pp.id !== hitP.id && pp.x === nx && pp.y === ny);
          if (!blocked) { hitP.x = nx; hitP.y = ny; }
        }
      }

      const extra = this.triggerBarrelChain(player.id, originalCells);
      const affected = originalCells.concat(extra);

      if (attack.poison) {
        this.hazards.push({ type: "poison", x: msg.x, y: msg.y, size: attack.size, damage: attack.damage, ticks: attack.ticks, ownerId: player.id });
      }
      if (attack.target === "direction" && attack.moveSelf) {
        const dest = originalCells[originalCells.length - 1] || { x: player.x, y: player.y };
        const occupied = Object.values(this.players).some(p => p.alive && p.id !== player.id && p.x === dest.x && p.y === dest.y);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
      return affected;
    }

    // ---- Effets instantanés : piège, téléportation, soin, bouclier, tir de précision, laser ----
    let affected = [];
    if (attack.target === "cell" && attack.trap) {
      if (inBounds(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) { this.hazards.push({ type: "mine", x: msg.x, y: msg.y, damage: attack.damage, ownerId: player.id }); affected = [{ x: msg.x, y: msg.y }]; }
    } else if (attack.target === "cell" && attack.teleport) {
      const origin = { x: player.x, y: player.y };
      const dist = Math.abs(msg.x - player.x) + Math.abs(msg.y - player.y);
      if (inBounds(msg.x, msg.y) && dist <= attack.range && !hitPlayerAt(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) {
        player.x = msg.x; player.y = msg.y;
        affected = [origin, { x: msg.x, y: msg.y }];
      }
    } else if (attack.target === "cell" && attack.instant) {
      if (inBounds(msg.x, msg.y)) {
        affected = [{ x: msg.x, y: msg.y }];
        const hitP = hitPlayerAt(msg.x, msg.y);
        if (hitP) this.applyDamage(player.id, hitP, attack.damage);
        const extra = this.triggerBarrelChain(player.id, [{ x: msg.x, y: msg.y }]);
        affected = affected.concat(extra);
      }
    } else if (attack.target === "line" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      const extra = this.triggerBarrelChain(player.id, affected);
      affected = affected.concat(extra);
    } else if (attack.target === "direction" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      const extra = this.triggerBarrelChain(player.id, affected);
      affected = affected.concat(extra);
      if (attack.moveSelf) {
        const dest = cells[cells.length - 1] || { x: player.x, y: player.y };
        const occupied = Object.values(this.players).some(p => p.alive && p.id !== player.id && p.x === dest.x && p.y === dest.y);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
    } else if (attack.target === "self" && attack.shield) {
      player.shield = true;
      affected = [{ x: player.x, y: player.y }];
    } else if (attack.target === "ally") {
      const targetId = msg.targetId || player.id;
      const target = this.players[targetId];
      if (target && target.alive) {
        const dist = Math.abs(target.x - player.x) + Math.abs(target.y - player.y);
        if (target.id === player.id || dist <= 2) { this.applyHeal(target, attack.heal); affected = [{ x: target.x, y: target.y }]; }
      }
    }
    return affected;
  }

  hillTick() {
    if (this.status !== "playing" || this.mode !== "kingHill") { clearInterval(this.hillTimer); return; }
    let changed = false;
    for (const p of Object.values(this.players)) {
      if (p.alive && onHill(p.x, p.y)) { p.score += 1; changed = true; }
    }
    if (changed) {
      this.broadcast(this.publicState());
      this.checkWinCondition();
    }
  }

  secondTick() {
    if (this.status !== "playing") return;

    this.purgeStaleDisconnected();

    for (const p of Object.values(this.players)) {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) {
        const spawn = this.freeSpawn();
        p.alive = true; p.hp = Math.round(START_HP / 2); p.x = spawn.x; p.y = spawn.y; p.respawnAt = null;
        this.pushLog(`${p.pseudo} revient dans l'arène.`);
      }
    }

    this.hazards = this.hazards.filter(h => {
      if (h.type !== "poison") return true;
      const cells = this.cellsForZone(h.x, h.y, h.size);
      for (const p of Object.values(this.players)) {
        if (p.alive && cells.some(c => c.x === p.x && c.y === p.y)) this.applyDamage(h.ownerId, p, h.damage);
      }
      h.ticks -= 1;
      return h.ticks > 0;
    });

    if (this.status !== "playing") return;

    if (this.shrinkEnabled) {
      if (this.shrinkMode !== "onKO" && this.shrinkRadius > SHRINK_MIN_RADIUS &&
          Date.now() - this.lastShrinkAt >= this.shrinkIntervalSec * 1000) {
        this.shrinkRadius -= 1;
        this.lastShrinkAt = Date.now();
        this.pushLog("⚠️ La zone se rétrécit !");
      }
      for (const p of Object.values(this.players)) {
        if (p.alive && this.isVoid(p.x, p.y)) this.applyDamage(null, p, SHRINK_DAMAGE_PER_SEC);
      }
      if (this.status !== "playing") return; // la zone peut avoir achevé la partie
    }

    if (this.powerupsEnabled) {
      const intervalMs = this.powerupIntervalSec * 1000;
      if (Date.now() - this.lastPowerupSpawn >= intervalMs && this.powerups.length < MAX_POWERUPS_ON_MAP) {
        const spot = this.freeSpawn();
        const type = POWERUP_TYPES[randInt(POWERUP_TYPES.length)];
        this.powerups.push({ id: crypto.randomUUID(), x: spot.x, y: spot.y, type });
        this.lastPowerupSpawn = Date.now();
      }
    }

    this.broadcast(this.publicState());
  }

  // ---- Fin de Chrono : gagnant, égalité -> mort subite ----
  resolveChronoEnd() {
    const list = Object.values(this.players);

    if (this.teamsEnabled) {
      const teamsPresent = [...new Set(list.map(p => p.team).filter(Boolean))];
      const sums = teamsPresent.map(t => ({ t, sum: list.filter(p => p.team === t).reduce((s, p) => s + p.eliminations, 0) }));
      const max = sums.reduce((m, s) => Math.max(m, s.sum), 0);
      const top = sums.filter(s => s.sum === max && max > 0).map(s => s.t);
      if (top.length === 1) { this.endGame(list.filter(p => p.team === top[0]).map(p => p.id), "chrono"); return; }
      if (top.length > 1) {
        this.suddenDeath = true;
        this.suddenDeathIds = new Set(list.filter(p => top.includes(p.team)).map(p => p.id));
        this.chronoEndAt = null;
        this.pushLog("Égalité entre équipes ! Mort subite : le prochain K.O. gagne.");
        this.broadcast(this.publicState());
        return;
      }
      this.endGame([], "chrono");
      return;
    }

    const maxKO = list.reduce((m, p) => Math.max(m, p.eliminations), 0);
    const top = list.filter(p => p.eliminations === maxKO && maxKO > 0);
    if (top.length === 1) { this.endGame([top[0].id], "chrono"); return; }
    if (top.length > 1) {
      this.suddenDeath = true;
      this.suddenDeathIds = new Set(top.map(p => p.id));
      this.chronoEndAt = null;
      this.pushLog("Égalité ! Mort subite : le prochain K.O. gagne.");
      this.broadcast(this.publicState());
      return;
    }
    this.endGame([], "chrono");
  }

  // Pioche le prochain joueur dans un "sac" mélangé, sans le remettre dedans —
  // ainsi tout le monde joue avant qu'un même joueur puisse rejouer. Le sac est
  // reconstitué (et remélangé) avec les joueurs vivants du moment dès qu'il est vide.
  pickNextAttacker() {
    while (this.turnQueue.length) {
      const id = this.turnQueue.shift();
      const p = this.players[id];
      if (p && p.alive) return p;
    }
    const alive = Object.values(this.players).filter(p => p.alive).map(p => p.id);
    if (alive.length === 0) return null;
    for (let i = alive.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [alive[i], alive[j]] = [alive[j], alive[i]];
    }
    this.turnQueue = alive;
    const id = this.turnQueue.shift();
    return this.players[id] || null;
  }

  tick() {
    if (this.status !== "playing") return;
    const now = Date.now();

    if (this.mode === "chrono" && this.chronoEndAt && now >= this.chronoEndAt && !this.suddenDeath) {
      this.resolveChronoEnd();
      if (this.status !== "playing") return;
      this.scheduleTick(TURN_GAP_MS);
      return;
    }

    if (this.turn && now > this.turn.deadline) {
      const p = this.players[this.turn.playerId];
      this.pushLog(`${p ? p.pseudo : "Le joueur"} n'a pas utilisé son arme à temps.`);
      this.turn = null;
      this.broadcast(this.publicState());
      this.scheduleTick(TURN_GAP_MS);
      return;
    }

    if (!this.turn) {
      const chosen = this.pickNextAttacker();
      if (!chosen) { this.scheduleTick(1000); return; }
      let attack = ATTACKS[randInt(ATTACKS.length)];
      if (ATTACKS.length > 1) {
        let guard = 0;
        while (attack.id === this.lastAttackId && guard < 10) { attack = ATTACKS[randInt(ATTACKS.length)]; guard++; }
      }
      this.lastAttackId = attack.id;
      this.turn = { playerId: chosen.id, attack, deadline: Date.now() + ATTACK_WINDOW_MS };
      this.pushLog(`${chosen.pseudo} reçoit : ${attack.name} !`);
      this.broadcast(this.publicState());
      this.scheduleTick(ATTACK_WINDOW_MS + 200);
    } else {
      this.scheduleTick(1000);
    }
  }
}

// ---- Registre des rooms en mémoire ----
const rooms = new Map();
function getOrCreateRoom(code) {
  code = code.toUpperCase();
  let room = rooms.get(code);
  if (!room) { room = new Room(code); rooms.set(code, room); }
  room.lastActivity = Date.now();
  return room;
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hasPlayers = Object.keys(room.players).length > 0;
    if (!hasPlayers && now - room.lastActivity > ROOM_IDLE_CLEANUP_MS) {
      if (room.timer) clearTimeout(room.timer);
      if (room.hillTimer) clearInterval(room.hillTimer);
      if (room.secondTimer) clearInterval(room.secondTimer);
      room.pendingAttacks.forEach(h => clearTimeout(h));
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10);
cleanupInterval.unref();

// ---- Serveur HTTP + WebSocket ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (url.pathname === "/api/create" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (e) { /* ignore */ }
      const code = genCode();
      const room = getOrCreateRoom(code);
      room.isPublic = !!parsed.isPublic;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    });
    return;
  }

  if (url.pathname === "/api/public-rooms" && req.method === "GET") {
    const list = [];
    for (const room of rooms.values()) {
      const count = Object.keys(room.players).length;
      if (room.isPublic && room.status !== "playing" && count > 0) {
        list.push({
          code: room.code,
          hostPseudo: (room.players[room.hostId] && room.players[room.hostId].pseudo) || "?",
          players: count,
          maxPlayers: MAX_PLAYERS,
          status: room.status,
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  if (url.pathname === "/api/modes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MODES));
    return;
  }

  if (url.pathname === "/api/maps") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MAPS));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("CapNaval backend OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const code = url.searchParams.get("code");
    const pseudo = (url.searchParams.get("pseudo") || "Joueur").slice(0, 16);
    const clientId = url.searchParams.get("clientId") || null;
    if (!code) { ws.close(1008, "code manquant"); return; }

    const room = getOrCreateRoom(code);
    const player = room.addPlayer(ws, pseudo, clientId);
    if (!player) { ws.send(JSON.stringify({ type: "error", message: "Partie pleine — 6 joueurs max." })); ws.close(1008, "full"); return; }

    ws.send(JSON.stringify({ type: "welcome", playerId: player.id, code: room.code, modes: MODES, maps: MAPS }));
    room.pushLog(`${pseudo} a rejoint la partie.`);
    room.broadcast(room.publicState());

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      room.lastActivity = Date.now();
      const p = room.players[player.id];
      if (!p) return;
      if (msg.type === "start" && player.id === room.hostId && (room.status === "lobby" || room.status === "ended")) {
        room.start(msg.mode, msg.config);
      } else if (msg.type === "move" && room.status === "playing") {
        room.handleMove(p, msg);
      } else if (msg.type === "attack" && room.status === "playing") {
        room.handleAttack(p, msg);
      } else if (msg.type === "endMatch" && player.id === room.hostId && room.status === "playing") {
        room.abortToLobby();
      } else if (msg.type === "setPublic" && player.id === room.hostId) {
        room.isPublic = !!msg.value;
        room.broadcast(room.publicState());
      } else if (msg.type === "leave") {
        room.removePlayerFully(player.id);
        room.broadcast(room.publicState());
        try { ws.close(1000, "left"); } catch (e) { /* ignore */ }
      }
    });

    ws.on("close", () => {
      room.handleDisconnect(player.id);
      room.broadcast(room.publicState());
    });
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`CapNaval backend en écoute sur le port ${PORT}`));
}

module.exports = { Room, MODES, MAPS, ATTACKS, GRID_SIZE, RECONNECT_GRACE_MS };
