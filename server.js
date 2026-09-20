// ===== CapNaval — serveur Node.js + ws (pour Render, pas de Durable Object) =====
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const DEFAULT_GRID_SIZE_MIN = 8;
const DEFAULT_GRID_SIZE_MAX = 16;
const MUD_COOLDOWN_MULT_DEFAULT = 2;
const SPEED_COOLDOWN_MULT = 0.5;
const RESIST_DAMAGE_MULT = 0.5;
const BUFF_DURATION_SEC_DEFAULT = 10;
const RECONNECT_GRACE_MS = 90000; // 90s pour se reconnecter avant d'être retiré pour de bon
const SHRINK_PRESETS_SEC = { slow: 30, medium: 18, fast: 9 };
const SHRINK_MODES = ["slow", "medium", "fast", "onKO", "custom"];
const SHRINK_INITIAL_RADIUS = 6;
const SHRINK_MIN_RADIUS = 1;
const SHRINK_DAMAGE_PER_SEC = 6;
const HILL_TICK_MS = 2000;
const DEFAULT_GRID_SIZE = 12;
const DEFAULT_TELEGRAPH_MS = 1300;
const NUKE_RESOLVE_DELAY_MS = 1700; // dégâts appliqués juste au moment où l'écran vire au blanc côté client
const DEFAULT_POWERUP_INTERVAL_SEC = 14;
const POWERUP_TYPES = ["heal", "resist", "speed"];
const ROOM_IDLE_CLEANUP_MS = 1000 * 60 * 60 * 3;
const MAX_PLAYERS_HARD_CAP = 6;
const BOT_DIFFICULTIES = ["easy", "medium", "hard"];
const BOT_DODGE_CHANCE = { easy: 0.15, medium: 0.5, hard: 1 };
const BOT_ATTACK_DELAY_MS = { easy: [900, 2400], medium: [700, 1900], hard: [250, 700] };
const BOT_START_GRACE_MS = 3200; // ne bouge pas tant que le décompte 3-2-1-GO joue côté client
const BOT_FLEE_ATTACKS = new Set(["charge", "shockwave"]); // attaques de mêlée à fuir

// ---- Valeurs par défaut des paramètres réglables par l'hôte ----
const DEFAULT_MOVE_COOLDOWN_MS = 800;
const DEFAULT_ATTACK_WINDOW_SEC = 12;
const DEFAULT_TURN_GAP_SEC = 2.5;
const DEFAULT_START_HP = 100;
const DEFAULT_RESPAWN_DELAY_SEC = 4;
const DEFAULT_RESPAWN_HP_PERCENT = 50;
const DEFAULT_DAMAGE_MULTIPLIER = 1;
const DEFAULT_BARREL_DAMAGE = 22;
const DEFAULT_POWERUP_MAX_ON_MAP = 3;

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#f97316"];
const TEAM_COLORS = { A: "#ef4444", B: "#3b82f6" };

const ATTACKS = [
  { id: "meteor",       name: "Météorite",         desc: "Frappe une zone 3x3 choisie",                 target: "zone", size: 3, damage: 25, telegraphMs: 1300 },
  { id: "airstrike",    name: "Frappe aérienne",   desc: "3 impacts en rafale dans une zone 5x5, instantané", target: "zone", size: 5, damage: 15, hits: 3, random: true, instant: true, staggered: true },
  { id: "meteorShower", name: "Pluie de météores", desc: "5 impacts en rafale dans une zone 6x6, instantané", target: "zone", size: 6, damage: 14, hits: 5, random: true, instant: true, staggered: true },
  { id: "napalm",       name: "Chute de napalme",  desc: "Choisis une case : un brasier 3x3 tourne dans les 4 coins d'une zone 5x5, laisse des flammes, instantané — rarissime", target: "cell", damage: 16, hits: 4, subSize: 3, offsets: [[-1,-1],[1,-1],[1,1],[-1,1]], instant: true, staggered: true, leavesFire: true, fireDamage: 7, fireTicks: 4, weight: 0.12 },
  { id: "acidRain",     name: "Pluie acide",       desc: "Choisis une zone 7x7 : ~10 cases deviennent toxiques 10s, au hasard", target: "zone", size: 7, acidRain: true, drops: 10, dropDamage: 6, dropTicks: 10, forceTelegraph: true, telegraphMs: 1400, weight: 0.35 },
  { id: "nuke",         name: "Bombe nucléaire",   desc: "Rase toute la carte, instantané — secrète, code requis", target: "self", damage: 999, instant: true, nuke: true, weight: 0, secret: true },
  { id: "snipe",        name: "Tir de précision",  desc: "Dégâts élevés sur une case, instantané",       target: "cell", damage: 35, instant: true },
  { id: "laser",        name: "Rayon laser",       desc: "Frappe une ligne entière, instantané",         target: "line", damage: 16, instant: true },
  { id: "chainLightning", name: "Chaîne d'éclairs", desc: "Frappe une case puis rebondit sur les joueurs les plus proches, instantané", target: "cell", damage: 18, chain: true, chainHops: 3, chainFalloff: 0.75, instant: true },
  { id: "shockwave",    name: "Onde de choc",      desc: "Frappe toutes les cases autour de toi, instantané", target: "self", damage: 18, instant: true },
  { id: "earthquake",   name: "Séisme",            desc: "Secoue toute la carte : petits dégâts et déplace tout le monde d'une case au hasard, instantané", target: "self", damage: 6, earthquake: true, instant: true },
  { id: "gunline",      name: "Rafale",            desc: "Mitraille une ligne, stoppée par les murs",   target: "line", damage: 12, telegraphMs: 1300 },
  { id: "grenade",      name: "Grenade",           desc: "Explosion sur une zone 2x2",                   target: "zone", size: 2, damage: 20, telegraphMs: 1100 },
  { id: "arrow",        name: "Flèche perforante", desc: "Choisis une direction : transperce tout, même les murs, instantané", target: "direction", damage: 16, distance: 12, moveSelf: false, piercesWalls: true, instant: true },
  { id: "charge",       name: "Charge",            desc: "Fonce en ligne droite sur 3 cases, instantané, un peu plus rapide", target: "direction", damage: 22, distance: 3, moveSelf: true, instant: true },
  { id: "tornado",      name: "Tornade",           desc: "Aspire les joueurs vers le centre d'une zone 3x3", target: "zone", size: 3, damage: 10, pull: true, telegraphMs: 1300 },
  { id: "net",          name: "Filet",             desc: "Immobilise le joueur touché 3 secondes",       target: "cell", damage: 5, root: true, rootMs: 3000, telegraphMs: 1000 },
  { id: "frost",        name: "Vague de givre",    desc: "Ralentit et blesse une zone 3x3, laisse une trace glacée",   target: "zone", size: 3, damage: 8, slow: true, slowMs: 1500, traceTicks: 6, telegraphMs: 1200 },
  { id: "mine",         name: "Piège explosif",    desc: "Pose une mine invisible sur une case",         target: "cell", damage: 30, trap: true },
  { id: "heal",         name: "Soin d'urgence",    desc: "Soigne toi ou un allié proche",                target: "ally", heal: 25 },
  { id: "healZone",     name: "Zone de soin",      desc: "Choisis une zone 3x3 qui soigne au fil du temps", target: "zone", size: 3, heal: 10, ticks: 4, healZone: true, forceTelegraph: true, telegraphMs: 1200 },
  { id: "shield",       name: "Bouclier",          desc: "Absorbe la prochaine attaque reçue",           target: "self", shield: true },
  { id: "poison",       name: "Zone toxique",      desc: "Nuage toxique 3x3, dégâts chaque seconde",     target: "zone", size: 3, damage: 6, poison: true, ticks: 4, telegraphMs: 1300 },
  { id: "teleport",     name: "Téléportation",     desc: "Téléporte-toi n'importe où sur la carte",      target: "cell", teleport: true, range: 999 },
];

// Champs numériques qu'un hôte peut régler finement par attaque (bornes de sécurité incluses).
// Seuls les champs présents sur l'attaque d'origine sont proposés au client.
const TUNABLE_FIELD_RANGES = {
  damage: [0, 200], heal: [0, 150], size: [1, 9], ticks: [1, 20],
  slowMs: [200, 8000], rootMs: [200, 8000], traceTicks: [1, 15],
  distance: [1, 16], hits: [1, 10], telegraphMs: [200, 6000],
  fireDamage: [0, 50], fireTicks: [1, 12], dropDamage: [0, 50], dropTicks: [1, 20], drops: [1, 20],
  chainHops: [0, 6], chainFalloff: [0.1, 1], range: [1, 999],
};
function getAttackTunables(attack) {
  const out = {};
  for (const field of Object.keys(TUNABLE_FIELD_RANGES)) {
    if (attack[field] !== undefined) out[field] = attack[field];
  }
  return out;
}

const MODES = {
  survivor: { label: "Dernier survivant", desc: "Pas de respawn. Le dernier debout, ou la dernière équipe, gagne.", respawns: false },
  koHunt:   { label: "Chasse au K.O.",    desc: "Premier à X éliminations gagne, cumul d'équipe si activé.", respawns: true },
  kingHill: { label: "Roi de la case",    desc: "Reste sur la case centrale pour marquer des points. Premier à X points gagne.", respawns: true },
  chrono:   { label: "Chrono",            desc: "Partie limitée dans le temps. Le plus d'éliminations à la fin gagne, mort subite en cas d'égalité.", respawns: true },
  boss:     { label: "Chasse au Boss",    desc: "Un joueur (ou un bot) devient le Boss, bien plus costaud. Les autres doivent l'abattre avant qu'il ne les élimine tous. Pas de respawn.", respawns: false },
  ctf:      { label: "Capture du drapeau", desc: "2 équipes, 2 bases. Vole le drapeau adverse et ramène-le sur ta base pour marquer. Premier à X captures gagne.", respawns: true },
};

const MAPS = {
  open:    { label: "Terrain ouvert", desc: "Aucun obstacle.",                                  walls: 0,  barrels: 0,  mud: 0 },
  ruins:   { label: "Ruines",         desc: "Des murs pour se mettre à couvert.",                walls: 14, barrels: 4,  mud: 0 },
  swamp:   { label: "Marécage",       desc: "Des flaques de boue ralentissent les déplacements.",walls: 6,  barrels: 2,  mud: 12 },
  arsenal: { label: "Arsenal",        desc: "Beaucoup de tonneaux explosifs, réaction en chaîne.",walls: 8,  barrels: 14, mud: 0 },
  custom:  { label: "Personnalisé",   desc: "Ta carte, conçue et enregistrée par toi.",          walls: 0,  barrels: 0,  mud: 0 },
};

function randInt(n) { return Math.floor(Math.random() * n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function numOr(v, def) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
function inBoundsGlobal(x, y, size) { return x >= 0 && y >= 0 && x < size && y < size; }
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[randInt(chars.length)];
  return s;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

class Room {
  constructor(code) {
    this.code = code;
    this.status = "lobby"; // lobby | playing | ended
    this.players = {};
    this.hazards = [];
    this.powerups = [];
    this.obstacles = { walls: [], barrels: [], mud: [] };
    this.mapId = "open";
    this.gridSize = DEFAULT_GRID_SIZE;
    this.passiveRegenPerSec = 0;
    this.powerupsEnabled = true;
    this.powerupIntervalSec = DEFAULT_POWERUP_INTERVAL_SEC;
    this.powerupMaxOnMap = DEFAULT_POWERUP_MAX_ON_MAP;
    this.lastPowerupSpawn = 0;
    this.teamsEnabled = false;
    this.pushEnabled = true;
    this.shrinkEnabled = false;
    this.shrinkMode = "medium";
    this.shrinkIntervalSec = SHRINK_PRESETS_SEC.medium;
    this.shrinkRadius = SHRINK_INITIAL_RADIUS;
    this.lastShrinkAt = 0;
    this.isPublic = false;
    this.maxPlayers = MAX_PLAYERS_HARD_CAP;
    this.turn = null;
    this.hostId = null;
    this.timer = null;
    this.hillTimer = null;
    this.secondTimer = null;
    this.lastActivity = Date.now();
    this.lastAttackId = null;
    this.attacksRuntime = ATTACKS;
    this.bossId = null;
    this.bossHpMultiplier = 3;
    this.flags = [];
    this.fillWithBots = false;
    this.fillBotDifficulty = "medium";
    this.activeTelegraphs = [];
    this.matchStartedAt = 0;
    this.turnQueue = [];
    this.pendingAttacks = new Set();

    // ---- Paramètres réglables par l'hôte ----
    this.moveCooldownMs = DEFAULT_MOVE_COOLDOWN_MS;
    this.attackWindowSec = DEFAULT_ATTACK_WINDOW_SEC;
    this.turnGapSec = DEFAULT_TURN_GAP_SEC;
    this.startingHP = DEFAULT_START_HP;
    this.respawnDelaySec = DEFAULT_RESPAWN_DELAY_SEC;
    this.respawnHpPercent = DEFAULT_RESPAWN_HP_PERCENT;
    this.damageMultiplier = DEFAULT_DAMAGE_MULTIPLIER;
    this.barrelDamage = DEFAULT_BARREL_DAMAGE;
    this.weaponNoRepeat = true;
    this.mineVisibleToAll = false;
    this.attackWeightOverrides = {}; // { attackId: multiplicateur } — taux de tirage par attaque
    this.telegraphMultiplier = 1;    // vitesse du clignotement d'esquive (plus bas = plus dur à esquiver)
    this.buffDurationSec = BUFF_DURATION_SEC_DEFAULT;
    this.mudSlowMultiplier = MUD_COOLDOWN_MULT_DEFAULT;
    this.spawnProtectionSec = 0;     // invulnérabilité temporaire après un (re)spawn

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
      hazards: this.hazards.map(h => h.type === "mine" ? { x: h.x, y: h.y, type: "mine", ownerId: h.ownerId } : h),
      powerups: this.powerups,
      obstacles: this.obstacles,
      mapId: this.mapId,
      mapLabel: MAPS[this.mapId] ? MAPS[this.mapId].label : null,
      teamsEnabled: this.teamsEnabled,
      pushEnabled: this.pushEnabled,
      moveCooldownMs: this.moveCooldownMs,
      mudSlowMultiplier: this.mudSlowMultiplier,
      mineVisibleToAll: this.mineVisibleToAll,
      teamColors: TEAM_COLORS,
      turn: this.turn ? {
        playerId: this.turn.playerId,
        attackId: this.turn.attack.id,
        attackName: this.turn.attack.name,
        deadline: this.turn.deadline,
      } : null,
      gridSize: this.gridSize,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      bossId: this.bossId,
      flags: this.flags,
      fillWithBots: this.fillWithBots,
      fillBotDifficulty: this.fillBotDifficulty,
      mode: this.mode,
      modeLabel: this.mode ? MODES[this.mode].label : null,
      config: this.config,
      chronoEndAt: this.chronoEndAt,
      suddenDeath: this.suddenDeath,
      hillCells: this.hillCells().map(([x, y]) => ({ x, y })),
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
  inBounds(x, y) { return inBoundsGlobal(x, y, this.gridSize); }

  // Cases centrales du mode Roi de la case, calculées selon la taille de grille active.
  hillCells() {
    const s = this.gridSize;
    const mid = Math.floor((s - 1) / 2);
    if (s % 2 === 0) return [[mid, mid], [mid, mid + 1], [mid + 1, mid], [mid + 1, mid + 1]];
    return [[mid, mid]];
  }
  onHill(x, y) { return this.hillCells().some(([hx, hy]) => hx === x && hy === y); }

  // ---- Zone qui rétrécit (façon battle royale) ----
  shrinkCenter() { return { x: (this.gridSize - 1) / 2, y: (this.gridSize - 1) / 2 }; }
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
        const x = randInt(this.gridSize), y = randInt(this.gridSize);
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

  // Carte conçue par l'hôte (enregistrée en local côté client, envoyée au lancement).
  // Sécurité : au moins 12 cases praticables (murs+tonneaux exclus), sinon repli sur "open".
  useCustomMap(customMap, excludeCells) {
    customMap = customMap || {};
    const excludeSet = new Set((excludeCells || []).map(c => `${c.x},${c.y}`));
    const used = new Set();
    const cleanList = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(c => c && Number.isInteger(c.x) && Number.isInteger(c.y) && this.inBounds(c.x, c.y) && !excludeSet.has(`${c.x},${c.y}`))
      .slice(0, 130)
      .filter(c => { const k = `${c.x},${c.y}`; if (used.has(k)) return false; used.add(k); return true; });

    const walls = cleanList(customMap.walls);
    const barrels = cleanList(customMap.barrels).map(c => ({ x: c.x, y: c.y, id: crypto.randomUUID() }));
    const mud = cleanList(customMap.mud);
    const freeWalkable = this.gridSize * this.gridSize - walls.length - barrels.length;
    if (freeWalkable < 12) { this.generateMap("open", excludeCells); return; }
    this.obstacles = { walls, barrels, mud };
    this.mapId = "custom";
  }

  freeSpawn() {
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(this.gridSize), y = randInt(this.gridSize);
      const occupied = Object.values(this.players).some(p => p.alive && p.x === x && p.y === y);
      if (!occupied && !this.isBlocked(x, y) && !this.isVoid(x, y)) return { x, y };
    }
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(this.gridSize), y = randInt(this.gridSize);
      const occupied = Object.values(this.players).some(p => p.alive && p.x === x && p.y === y);
      if (!occupied && !this.isBlocked(x, y)) return { x, y };
    }
    return { x: randInt(this.gridSize), y: randInt(this.gridSize) };
  }

  // ---- Joueurs / reconnexion ----
  // Évite les doublons de pseudo dans une même partie : pseudo, puis pseudo_1, pseudo_2...
  uniquePseudo(base, excludeId) {
    const taken = Object.values(this.players).filter(p => p.id !== excludeId).map(p => p.pseudo);
    if (!taken.includes(base)) return base;
    let n = 1;
    while (taken.includes(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  addPlayer(ws, pseudo, clientId, opts) {
    opts = opts || {};
    const avatarEmoji = opts.avatarEmoji ? String(opts.avatarEmoji).slice(0, 4) : null;
    if (clientId) {
      const existing = Object.values(this.players).find(p => p.clientId === clientId);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        existing.disconnectedAt = null;
        if (pseudo) existing.pseudo = this.uniquePseudo(pseudo, existing.id);
        if (avatarEmoji) existing.avatarEmoji = avatarEmoji;
        return existing;
      }
    }
    if (Object.keys(this.players).length >= this.maxPlayers) {
      const fillBot = Object.values(this.players).find(p => p.isFillBot);
      if (fillBot) delete this.players[fillBot.id];
      else return null;
    }
    if (Object.keys(this.players).length >= this.maxPlayers) return null;
    const id = crypto.randomUUID();
    const usedColors = Object.values(this.players).map(p => p.color);
    let color = null;
    if (opts.color && COLORS.includes(opts.color) && !usedColors.includes(opts.color)) color = opts.color;
    if (!color) color = COLORS.find(c => !usedColors.includes(c)) || COLORS[randInt(COLORS.length)];
    const spawn = this.freeSpawn();
    const player = {
      id, clientId: clientId || crypto.randomUUID(), pseudo: this.uniquePseudo(pseudo, null), color, avatarEmoji, x: spawn.x, y: spawn.y,
      hp: this.startingHP, alive: true, lastMove: 0, shield: false, respawnAt: null,
      eliminations: 0, score: 0, resistUntil: null, speedUntil: null, rootedUntil: null, slowedUntil: null, invulnUntil: null, forcedNextAttackId: null,
      damageDealt: 0, damageTaken: 0, timesKO: 0, team: null,
      connected: true, disconnectedAt: null, ws,
    };
    this.players[id] = player;
    if (!this.hostId) this.hostId = id;
    return player;
  }

  // Crée un joueur "bot" contrôlé par le serveur (utilisé pour le mode Boss).
  addBotPlayer(pseudo, difficulty) {
    const id = crypto.randomUUID();
    const usedColors = Object.values(this.players).map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[randInt(COLORS.length)];
    const spawn = this.freeSpawn();
    const bot = {
      id, clientId: "bot-" + id, pseudo: this.uniquePseudo(pseudo || "Bot", null), color, avatarEmoji: "🤖",
      x: spawn.x, y: spawn.y,
      hp: this.startingHP, alive: true, lastMove: 0, shield: false, respawnAt: null,
      eliminations: 0, score: 0, resistUntil: null, speedUntil: null, rootedUntil: null, slowedUntil: null, invulnUntil: null, forcedNextAttackId: null,
      damageDealt: 0, damageTaken: 0, timesKO: 0, team: null,
      connected: true, disconnectedAt: null, ws: null, isBot: true,
      botDifficulty: BOT_DIFFICULTIES.includes(difficulty) ? difficulty : "medium",
    };
    this.players[id] = bot;
    return bot;
  }

  // Complète (ou retire) des bots de remplissage pour atteindre maxPlayers dans le
  // salon d'attente — jamais pendant une partie en cours. Les vrais joueurs priment
  // toujours : un bot de remplissage est retiré dès qu'un joueur en a besoin.
  syncBotFill() {
    if (this.status !== "lobby") return;
    if (!this.fillWithBots) {
      for (const id of Object.keys(this.players)) {
        if (this.players[id].isFillBot) delete this.players[id];
      }
      return;
    }
    let fillBotIds = Object.values(this.players).filter(p => p.isFillBot).map(p => p.id);
    const realCount = Object.keys(this.players).length - fillBotIds.length;
    while (realCount + fillBotIds.length > this.maxPlayers && fillBotIds.length > 0) {
      const id = fillBotIds.pop();
      delete this.players[id];
    }
    let n = 1;
    while (Object.keys(this.players).length < this.maxPlayers) {
      const bot = this.addBotPlayer(`Bot ${n}`, this.fillBotDifficulty);
      bot.isFillBot = true;
      n++;
    }
  }

  // Retire tout bot résiduel d'une précédente partie en mode Boss — jamais les
  // bots de remplissage, qui doivent survivre au passage salon -> partie.
  removeAllBots() {
    for (const id of Object.keys(this.players)) {
      if (this.players[id].isBot && !this.players[id].isFillBot) delete this.players[id];
    }
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
      this.syncBotFill();
    }
  }

  removePlayerFully(id) {
    const p = this.players[id];
    if (!p) return;
    this.pushLog(`${p.pseudo} a quitté la partie.`);
    delete this.players[id];
    if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null;
    if (this.status === "playing") this.checkWinCondition();
    this.syncBotFill();
  }

  // Exclusion par l'hôte : notifie le joueur visé puis le retire définitivement.
  kickPlayer(targetId) {
    const p = this.players[targetId];
    if (!p) return;
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify({ type: "kicked" })); } catch (e) { /* ignore */ }
      try { p.ws.close(1000, "kicked"); } catch (e) { /* ignore */ }
    }
    this.pushLog(`${p.pseudo} a été exclu par l'hôte.`);
    delete this.players[targetId];
    if (this.hostId === targetId) this.hostId = Object.keys(this.players)[0] || null;
    if (this.status === "playing") this.checkWinCondition();
    this.syncBotFill();
    this.broadcast(this.publicState());
  }

  // Transfert de la propriété du salon à un autre joueur connecté.
  transferHost(targetId) {
    const p = this.players[targetId];
    if (!p || !p.connected) return;
    this.hostId = targetId;
    this.pushLog(`${p.pseudo} est désormais l'hôte.`);
    this.broadcast(this.publicState());
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

  abortToLobby() {
    if (this.status === "lobby") return;
    this.status = "lobby";
    this.removeAllBots();
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
    this.activeTelegraphs = [];
    this.pushLog("L'hôte a terminé la partie. Retour au salon.");
    this.broadcast(this.publicState());
  }

  // ---- Démarrage / relance ----
  start(mode, rawConfig) {
    if (this.status === "playing") return;
    for (const [id, p] of Object.entries(this.players)) {
      if (!p.connected) { delete this.players[id]; if (this.hostId === id) this.hostId = Object.keys(this.players)[0] || null; }
    }
    if (Object.keys(this.players).length < 1) return;
    if (!MODES[mode]) mode = "koHunt";
    rawConfig = rawConfig || {};
    this.removeAllBots(); // repart toujours d'un état propre : un éventuel bot d'une précédente partie Boss disparaît

    const config = {};
    if (mode === "koHunt") config.targetKO = clamp(parseInt(rawConfig.targetKO) || 5, 1, 50);
    if (mode === "kingHill") config.targetScore = clamp(parseInt(rawConfig.targetScore) || 20, 1, 200);
    if (mode === "chrono") config.minutes = clamp(parseFloat(rawConfig.minutes) || 5, 1, 60);
    if (mode === "ctf") config.targetCaptures = clamp(parseInt(rawConfig.targetCaptures) || 3, 1, 20);

    this.mode = mode;
    this.config = config;
    this.gridSize = clamp(Math.round(numOr(rawConfig.gridSize, DEFAULT_GRID_SIZE)), DEFAULT_GRID_SIZE_MIN, DEFAULT_GRID_SIZE_MAX);
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

    // ---- Paramètres avancés ----
    this.startingHP = clamp(Math.round(numOr(rawConfig.startingHP, DEFAULT_START_HP)), 30, 300);
    this.respawnDelaySec = clamp(numOr(rawConfig.respawnDelaySec, DEFAULT_RESPAWN_DELAY_SEC), 1, 20);
    this.respawnHpPercent = clamp(Math.round(numOr(rawConfig.respawnHpPercent, DEFAULT_RESPAWN_HP_PERCENT)), 5, 100);
    this.attackWindowSec = clamp(numOr(rawConfig.attackWindowSec, DEFAULT_ATTACK_WINDOW_SEC), 4, 60);
    this.turnGapSec = clamp(numOr(rawConfig.turnGapSec, DEFAULT_TURN_GAP_SEC), 0.5, 15);
    this.moveCooldownMs = clamp(Math.round(numOr(rawConfig.moveCooldownMs, DEFAULT_MOVE_COOLDOWN_MS)), 150, 3000);
    this.damageMultiplier = clamp(numOr(rawConfig.damageMultiplier, DEFAULT_DAMAGE_MULTIPLIER), 0.25, 3);
    this.barrelDamage = clamp(Math.round(numOr(rawConfig.barrelDamage, DEFAULT_BARREL_DAMAGE)), 0, 100);
    this.powerupMaxOnMap = clamp(Math.round(numOr(rawConfig.powerupMaxOnMap, DEFAULT_POWERUP_MAX_ON_MAP)), 0, 8);
    this.weaponNoRepeat = rawConfig.weaponNoRepeat !== false && rawConfig.weaponNoRepeat !== "false";
    this.mineVisibleToAll = rawConfig.mineVisibleToAll === true || rawConfig.mineVisibleToAll === "true";

    this.attackWeightOverrides = {};
    if (rawConfig.attackWeights && typeof rawConfig.attackWeights === "object") {
      for (const a of ATTACKS) {
        const raw = rawConfig.attackWeights[a.id];
        if (raw !== undefined && raw !== "") this.attackWeightOverrides[a.id] = clamp(numOr(raw, 100) / 100, 0, 5);
      }
    }
    const fieldOverrides = (rawConfig.attackOverrides && typeof rawConfig.attackOverrides === "object") ? rawConfig.attackOverrides : {};
    this.attacksRuntime = ATTACKS.map(a => {
      const ov = fieldOverrides[a.id];
      if (!ov || typeof ov !== "object") return a;
      const merged = { ...a };
      for (const [field, range] of Object.entries(TUNABLE_FIELD_RANGES)) {
        if (a[field] === undefined || ov[field] === undefined || ov[field] === "") continue;
        merged[field] = clamp(numOr(ov[field], a[field]), range[0], range[1]);
      }
      return merged;
    });
    this.telegraphMultiplier = clamp(numOr(rawConfig.telegraphMultiplier, 1), 0.4, 3);
    this.buffDurationSec = clamp(numOr(rawConfig.buffDurationSec, BUFF_DURATION_SEC_DEFAULT), 3, 30);
    this.mudSlowMultiplier = clamp(numOr(rawConfig.mudSlowMultiplier, MUD_COOLDOWN_MULT_DEFAULT), 1, 5);
    this.spawnProtectionSec = clamp(numOr(rawConfig.spawnProtectionSec, 0), 0, 8);
    this.passiveRegenPerSec = clamp(numOr(rawConfig.passiveRegenPerSec, 0), 0, 10);

    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    this.lastAttackId = null;
    this.turnQueue = [];
    this.turn = null;
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.activeTelegraphs = [];

    const hillExclude = mode === "kingHill" ? this.hillCells().map(([x, y]) => ({ x, y })) : [];
    if (rawConfig.mapId === "custom" && rawConfig.customMap) this.useCustomMap(rawConfig.customMap, hillExclude);
    else this.generateMap(rawConfig.mapId, hillExclude);

    this.bossId = null;
    if (mode === "boss") {
      this.bossHpMultiplier = clamp(numOr(rawConfig.bossHpMultiplier, 3), 1.5, 6);
      this.teamsEnabled = false; // le mode Boss n'a pas de sens avec des équipes
      if (rawConfig.bossIsBot === true || rawConfig.bossIsBot === "true") {
        const bot = this.addBotPlayer(rawConfig.bossPseudo || "Boss Bot");
        this.bossId = bot.id;
      } else {
        const ids = Object.keys(this.players);
        const wanted = rawConfig.bossPlayerId;
        this.bossId = (wanted && wanted !== "random" && this.players[wanted]) ? wanted : ids[randInt(ids.length)];
      }
    }

    this.flags = [];
    if (mode === "ctf") {
      this.teamsEnabled = true; // la capture du drapeau exige deux équipes
      const bx = 1, by = 1, bx2 = this.gridSize - 2, by2 = this.gridSize - 2;
      const clearBase = (x, y) => {
        this.obstacles.walls = this.obstacles.walls.filter(w => !(w.x === x && w.y === y));
        this.obstacles.barrels = this.obstacles.barrels.filter(b => !(b.x === x && b.y === y));
      };
      clearBase(bx, by); clearBase(bx2, by2);
      this.flags = [
        { team: "A", baseX: bx, baseY: by, x: bx, y: by, carrierId: null },
        { team: "B", baseX: bx2, baseY: by2, x: bx2, y: by2, carrierId: null },
      ];
    }

    const playerList = Object.values(this.players);
    playerList.forEach((p, idx) => {
      const spawn = this.freeSpawn();
      const isBoss = mode === "boss" && p.id === this.bossId;
      p.hp = isBoss ? Math.round(this.startingHP * this.bossHpMultiplier) : this.startingHP;
      p.alive = true; p.x = spawn.x; p.y = spawn.y;
      p.shield = false; p.respawnAt = null; p.resistUntil = null; p.speedUntil = null;
      p.rootedUntil = null; p.slowedUntil = null;
      p.invulnUntil = this.spawnProtectionSec > 0 ? Date.now() + this.spawnProtectionSec * 1000 : null;
      p.eliminations = 0; p.score = 0; p.damageDealt = 0; p.damageTaken = 0; p.timesKO = 0;
      p.team = this.teamsEnabled ? (idx % 2 === 0 ? "A" : "B") : null;
    });

    this.status = "playing";
    this.matchStartedAt = Date.now();
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

    this.scheduleTick(this.turnGapSec * 1000);
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
    this.activeTelegraphs = [];
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
    } else if (this.mode === "boss") {
      const boss = this.players[this.bossId];
      if (!boss || !boss.alive) {
        const winners = list.filter(p => p.id !== this.bossId && p.alive).map(p => p.id);
        this.endGame(winners, "boss");
        return;
      }
      const huntersAlive = list.filter(p => p.id !== this.bossId && p.alive);
      if (list.length > 1 && huntersAlive.length === 0) { this.endGame([this.bossId], "boss"); return; }
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
    } else if (this.mode === "ctf") {
      for (const t of teamsPresent) {
        const captures = list.filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
        if (captures >= this.config.targetCaptures) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "ctf"); return; }
      }
    }
  }

  // ---- Dégâts / éliminations ----
  applyDamage(attackerId, player, amount) {
    if (!player.alive) return;
    if (player.invulnUntil && Date.now() < player.invulnUntil) return; // protégé après son (re)spawn
    if (this.teamsEnabled && attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.team && attacker.team === player.team && attacker.id !== player.id) return;
    }
    if (player.shield) { player.shield = false; this.pushLog(`${player.pseudo} bloque l'attaque avec son bouclier !`); return; }
    amount = amount * this.damageMultiplier;
    if (player.resistUntil && Date.now() < player.resistUntil) amount = amount * RESIST_DAMAGE_MULT;
    amount = Math.max(0, Math.round(amount));
    player.hp = clamp(player.hp - amount, 0, this.startingHP);
    player.damageTaken += amount;
    if (attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.id !== player.id) attacker.damageDealt += amount;
    }
    if (player.hp === 0) this.onElimination(attackerId, player);
  }
  applyHeal(player, amount) { if (player.alive) player.hp = clamp(player.hp + amount, 0, this.startingHP); }

  onElimination(attackerId, victim) {
    victim.alive = false;
    victim.timesKO += 1;
    this.pushLog(`${victim.pseudo} est K.O. !`);

    if (this.mode === "ctf") {
      const dropped = this.flags.find(f => f.carrierId === victim.id);
      if (dropped) { dropped.carrierId = null; this.pushLog("Le drapeau tombe au sol !"); }
    }

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
    victim.respawnAt = respawns ? Date.now() + this.respawnDelaySec * 1000 : null;

    this.checkWinCondition();
  }

  // Joueur vivant le plus proche d'une case, en excluant certains ids (chaîne d'éclairs).
  nearestAliveExcluding(x, y, excludeIds) {
    let best = null, bestDist = Infinity;
    for (const p of Object.values(this.players)) {
      if (!p.alive || excludeIds.has(p.id)) continue;
      const d = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  cellsForZone(anchorX, anchorY, size) {
    const half = Math.floor(size / 2);
    const cells = [];
    for (let dx = -half; dx <= size - 1 - half; dx++) {
      for (let dy = -half; dy <= size - 1 - half; dy++) {
        const x = anchorX + dx, y = anchorY + dy;
        if (this.inBounds(x, y)) cells.push({ x, y });
      }
    }
    return cells;
  }

  // ---- Bonus au sol ----
  applyPowerup(player, type) {
    if (type === "heal") { this.applyHeal(player, 30); this.pushLog(`${player.pseudo} récupère un bonus de vie !`); }
    else if (type === "resist") { player.resistUntil = Date.now() + this.buffDurationSec * 1000; this.pushLog(`${player.pseudo} récupère un bonus de résistance !`); }
    else if (type === "speed") { player.speedUntil = Date.now() + this.buffDurationSec * 1000; this.pushLog(`${player.pseudo} récupère un bonus de vitesse !`); }
  }

  checkPowerupPickup(player, x, y) {
    const idx = this.powerups.findIndex(pu => pu.x === x && pu.y === y);
    if (idx < 0) return;
    const pu = this.powerups[idx];
    this.powerups.splice(idx, 1);
    this.applyPowerup(player, pu.type);
  }

  // ---- Capture du drapeau ----
  checkFlagInteractions(player, x, y) {
    if (this.mode !== "ctf" || !player.team) return;
    const myCarriedFlag = this.flags.find(f => f.carrierId === player.id);
    if (myCarriedFlag) { myCarriedFlag.x = x; myCarriedFlag.y = y; }

    for (const flag of this.flags) {
      if (flag.x !== x || flag.y !== y) continue;
      if (flag.team === player.team) {
        if (flag.carrierId) continue; // ne devrait pas arriver : son propre drapeau n'est jamais "porté"
        if (flag.x !== flag.baseX || flag.y !== flag.baseY) {
          flag.x = flag.baseX; flag.y = flag.baseY;
          this.pushLog(`${player.pseudo} ramène son drapeau à la base !`);
          continue;
        }
        if (myCarriedFlag && myCarriedFlag.team !== player.team) {
          myCarriedFlag.carrierId = null;
          myCarriedFlag.x = myCarriedFlag.baseX; myCarriedFlag.y = myCarriedFlag.baseY;
          player.score += 1;
          this.pushLog(`🚩 ${player.pseudo} capture le drapeau !`);
          this.checkWinCondition();
        }
      } else if (!flag.carrierId) {
        flag.carrierId = player.id;
        this.pushLog(`${player.pseudo} s'empare du drapeau adverse !`);
      }
    }
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
        if (!this.inBounds(bx, by)) continue;
        extra.push({ x: bx, y: by });
        const bp = hitPlayerAt(bx, by);
        if (bp) this.applyDamage(attackerId, bp, this.barrelDamage);
        if (this.isBarrel(bx, by)) queue.push({ x: bx, y: by });
      }
    }
    return extra;
  }

  // ---- Déplacement (avec poussée des autres joueurs) ----
  handleMove(player, msg) {
    if (!player.alive) return;
    const now = Date.now();
    if (player.rootedUntil && now < player.rootedUntil) return;
    let cooldown = this.moveCooldownMs;
    if (this.isMud(player.x, player.y)) cooldown *= this.mudSlowMultiplier;
    if (player.slowedUntil && now < player.slowedUntil) cooldown *= this.mudSlowMultiplier;
    if (player.speedUntil && now < player.speedUntil) cooldown = Math.round(cooldown * SPEED_COOLDOWN_MULT);
    if (now - player.lastMove < cooldown) return;

    const { x, y } = msg;
    if (typeof x !== "number" || typeof y !== "number" || !this.inBounds(x, y)) return;
    const dx = x - player.x, dy = y - player.y;
    if (!((Math.abs(dx) === 1 && dy === 0) || (dx === 0 && Math.abs(dy) === 1))) return;
    if (this.isBlocked(x, y)) return;

    const occupant = Object.values(this.players).find(p => p.alive && p.id !== player.id && p.x === x && p.y === y);
    if (occupant) {
      if (!this.pushEnabled) return;
      const pushX = x + dx, pushY = y + dy;
      const pushBlocked = !this.inBounds(pushX, pushY) || this.isBlocked(pushX, pushY) ||
        Object.values(this.players).some(p => p.alive && p.id !== occupant.id && p.x === pushX && p.y === pushY);
      if (pushBlocked) return;
      occupant.x = pushX; occupant.y = pushY;
      this.pushLog(`${player.pseudo} pousse ${occupant.pseudo} !`);
      this.checkMineTrigger(occupant, pushX, pushY);
    }

    player.x = x; player.y = y; player.lastMove = now;
    this.checkMineTrigger(player, x, y);
    this.checkPowerupPickup(player, x, y);
    this.checkFlagInteractions(player, x, y);

    this.broadcast(this.publicState());
  }

  // Codes secrets : "nuke" force la bombe nucléaire au prochain tour du joueur ;
  // "choose" force n'importe quelle autre attaque valide (jamais la bombe elle-même).
  handleCheatCode(player, msg) {
    if (msg.code === "nuke") {
      player.forcedNextAttackId = "nuke";
      this.pushLog(`${player.pseudo} a activé un code secret… 👀`);
    } else if (msg.code === "choose" && msg.attackId && msg.attackId !== "nuke") {
      const valid = this.attacksRuntime.find(a => a.id === msg.attackId && !a.secret);
      if (valid) {
        player.forcedNextAttackId = valid.id;
        this.pushLog(`${player.pseudo} a activé un code secret… 👀`);
      }
    }
  }

  handleAttack(player, msg) {
    const turn = this.turn;
    if (!turn || turn.playerId !== player.id) return;
    if (Date.now() > turn.deadline) return;
    const attack = turn.attack;
    this.turn = null;

    if (attack.nuke) {
      // On prévient tout le monde immédiatement (déclenche la cinématique côté client),
      // puis on applique réellement les dégâts après coup — sinon la partie pourrait se
      // terminer et afficher l'écran de victoire avant même que l'animation ne commence.
      this.pushLog(`${player.pseudo} déclenche ${attack.name} !`);
      this.broadcast({ type: "attackResolved", attackId: attack.id, by: player.id, cells: [], groups: null });
      this.broadcast(this.publicState());
      const handle = setTimeout(() => {
        this.pendingAttacks.delete(handle);
        if (this.status !== "playing") return;
        const liveAttacker = this.players[player.id];
        if (!liveAttacker) return;
        this.resolveAttackEffects(liveAttacker, attack, msg, null);
        this.broadcast(this.publicState());
      }, NUKE_RESOLVE_DELAY_MS);
      if (handle.unref) handle.unref();
      this.pendingAttacks.add(handle);
      if (this.status === "playing") this.scheduleTick(this.turnGapSec * 1000 + NUKE_RESOLVE_DELAY_MS);
      return;
    }

    const isDelayed = (!!attack.damage || attack.forceTelegraph) && !attack.trap && !attack.instant;

    if (!isDelayed) {
      const result = this.resolveAttackEffects(player, attack, msg, null);
      this.pushLog(`${player.pseudo} utilise ${attack.name} !`);
      this.broadcast({ type: "attackResolved", attackId: attack.id, by: player.id, cells: result.cells, groups: result.groups || null });
    } else {
      const cells = this.computeAttackCells(player, attack, msg);
      const delay = Math.round((attack.telegraphMs || DEFAULT_TELEGRAPH_MS) * this.telegraphMultiplier);
      const resolveAt = Date.now() + delay;
      this.pushLog(`${player.pseudo} prépare ${attack.name} !`);
      this.broadcast({ type: "telegraph", attackId: attack.id, by: player.id, cells, resolveAt });
      const telegraphEntry = { cells, resolveAt };
      this.activeTelegraphs.push(telegraphEntry);

      const handle = setTimeout(() => {
        this.pendingAttacks.delete(handle);
        this.activeTelegraphs = this.activeTelegraphs.filter(t => t !== telegraphEntry);
        if (this.status !== "playing") return;
        const liveAttacker = this.players[player.id];
        if (!liveAttacker) return;
        const result = this.resolveAttackEffects(liveAttacker, attack, msg, cells);
        this.broadcast({ type: "attackResolved", attackId: attack.id, by: liveAttacker.id, cells: result.cells, groups: result.groups || null });
        this.broadcast(this.publicState());
      }, delay);
      if (handle.unref) handle.unref();
      this.pendingAttacks.add(handle);
    }

    this.broadcast(this.publicState());
    if (this.status === "playing") this.scheduleTick(this.turnGapSec * 1000);
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
      return this.inBounds(msg.x, msg.y) ? [{ x: msg.x, y: msg.y }] : [];
    }
    if (attack.target === "self") {
      const cells = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = player.x + dx, y = player.y + dy;
        if (this.inBounds(x, y)) cells.push({ x, y });
      }
      return cells;
    }
    if (attack.target === "line") {
      const axis = msg.axis === "col" ? "col" : "row";
      const step = axis === "row" ? [1, 0] : [0, 1];
      const cells = [{ x: msg.x, y: msg.y }];
      let cx = msg.x, cy = msg.y;
      while (true) {
        const nx = cx + step[0], ny = cy + step[1];
        if (!this.inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      cx = msg.x; cy = msg.y;
      while (true) {
        const nx = cx - step[0], ny = cy - step[1];
        if (!this.inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      return cells;
    }
    if (attack.target === "direction") {
      const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const d = dirs[msg.dir] || [0, 0];
      let cx = player.x, cy = player.y;
      const cells = [];
      const maxSteps = attack.distance || this.gridSize;
      for (let step = 0; step < maxSteps; step++) {
        const nx = cx + d[0], ny = cy + d[1];
        if (!this.inBounds(nx, ny) || (!attack.piercesWalls && this.isWall(nx, ny))) break;
        cx = nx; cy = ny;
        cells.push({ x: cx, y: cy });
      }
      return cells;
    }
    return [];
  }

  // Retourne toujours { cells, groups }. `groups` (tableau de tableaux de cases)
  // n'est renseigné que pour les attaques "en rafale" (staggered côté client) —
  // il sert à afficher/jouer chaque impact un par un plutôt que tous en même temps.
  resolveAttackEffects(player, attack, msg, precomputedCells) {
    const hitPlayerAt = (x, y) => Object.values(this.players).find(p => p.alive && p.x === x && p.y === y);
    let affected = [];
    let groups = null;

    if (precomputedCells) {
      const originalCells = precomputedCells.slice();
      for (const c of originalCells) {
        const hitP = hitPlayerAt(c.x, c.y);
        if (!hitP) continue;
        if (attack.damage) this.applyDamage(player.id, hitP, attack.damage);
        if (attack.root && hitP.alive) hitP.rootedUntil = Date.now() + (attack.rootMs || 3000);
        if (attack.slow && hitP.alive) hitP.slowedUntil = Date.now() + (attack.slowMs || 1500);
      }

      if (attack.pull) {
        for (const c of originalCells) {
          const hitP = hitPlayerAt(c.x, c.y);
          if (!hitP) continue;
          const dx = Math.sign(msg.x - hitP.x), dy = Math.sign(msg.y - hitP.y);
          const nx = hitP.x + dx, ny = hitP.y + dy;
          const blocked = !this.inBounds(nx, ny) || this.isBlocked(nx, ny) ||
            Object.values(this.players).some(pp => pp.alive && pp.id !== hitP.id && pp.x === nx && pp.y === ny);
          if (!blocked) { hitP.x = nx; hitP.y = ny; }
        }
      }

      if (attack.acidRain) {
        const zone = this.cellsForZone(msg.x, msg.y, attack.size);
        const drops = shuffle(zone).slice(0, Math.min(attack.drops || 10, zone.length));
        for (const d of drops) {
          this.hazards.push({ type: "poison", x: d.x, y: d.y, size: 1, damage: attack.dropDamage || 6, ticks: attack.dropTicks || 10, ownerId: player.id });
        }
        groups = drops.map(d => [d]);
      }

      const extra = this.triggerBarrelChain(player.id, originalCells);
      affected = originalCells.concat(extra);

      if (attack.poison) {
        this.hazards.push({ type: "poison", x: msg.x, y: msg.y, size: attack.size, damage: attack.damage, ticks: attack.ticks, ownerId: player.id });
      }
      if (attack.slow) {
        this.hazards.push({ type: "frost", x: msg.x, y: msg.y, size: attack.size, damage: Math.round((attack.damage || 0) / 2), ticks: attack.traceTicks || 6, slowMs: attack.slowMs || 1500, ownerId: player.id });
      }
      if (attack.healZone) {
        this.hazards.push({ type: "healzone", x: msg.x, y: msg.y, size: attack.size, heal: attack.heal, ticks: attack.ticks, ownerId: player.id });
      }
      if (attack.target === "direction" && attack.moveSelf) {
        const dest = originalCells[originalCells.length - 1] || { x: player.x, y: player.y };
        const occupied = Object.values(this.players).some(p => p.alive && p.id !== player.id && p.x === dest.x && p.y === dest.y);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
      return { cells: affected, groups };
    }

    // ---- Effets instantanés : piège, téléportation, soin, bouclier, tirs directs, rafales ----
    if (attack.target === "cell" && attack.trap) {
      if (this.inBounds(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) { this.hazards.push({ type: "mine", x: msg.x, y: msg.y, damage: attack.damage, ownerId: player.id }); affected = [{ x: msg.x, y: msg.y }]; }
    } else if (attack.target === "cell" && attack.teleport) {
      const origin = { x: player.x, y: player.y };
      const dist = Math.abs(msg.x - player.x) + Math.abs(msg.y - player.y);
      if (this.inBounds(msg.x, msg.y) && dist <= attack.range && !hitPlayerAt(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) {
        player.x = msg.x; player.y = msg.y;
        affected = [origin, { x: msg.x, y: msg.y }];
      }
    } else if (attack.target === "cell" && attack.instant && attack.chain) {
      const hitIds = new Set([player.id]); // la chaîne ne rebondit jamais sur son lanceur
      let cx = msg.x, cy = msg.y, dmg = attack.damage, hops = 0;
      const maxHops = attack.chainHops || 3;
      const chainCells = [];
      while (hops <= maxHops) {
        const hitP = hops === 0 ? hitPlayerAt(cx, cy) : this.nearestAliveExcluding(cx, cy, hitIds);
        if (!hitP) break;
        this.applyDamage(player.id, hitP, Math.round(dmg));
        hitIds.add(hitP.id);
        chainCells.push({ x: hitP.x, y: hitP.y });
        cx = hitP.x; cy = hitP.y;
        dmg *= (attack.chainFalloff !== undefined ? attack.chainFalloff : 0.75);
        hops++;
      }
      affected = chainCells.concat(this.triggerBarrelChain(player.id, chainCells));
      groups = chainCells.map(c => [c]);
    } else if (attack.target === "cell" && attack.instant && !attack.subSize) {
      if (this.inBounds(msg.x, msg.y)) {
        affected = [{ x: msg.x, y: msg.y }];
        const hitP = hitPlayerAt(msg.x, msg.y);
        if (hitP) this.applyDamage(player.id, hitP, attack.damage);
        affected = affected.concat(this.triggerBarrelChain(player.id, [{ x: msg.x, y: msg.y }]));
      }
    } else if (attack.target === "line" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
    } else if (attack.target === "direction" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
      if (attack.moveSelf) {
        const dest = cells[cells.length - 1] || { x: player.x, y: player.y };
        const occupied = Object.values(this.players).some(p => p.alive && p.id !== player.id && p.x === dest.x && p.y === dest.y);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
    } else if (attack.target === "self" && attack.nuke) {
      // Bombe nucléaire : one-shot tout le monde, y compris le lanceur — personne n'est épargné.
      // Dégâts appliqués directement (pas d'applyDamage) pour ignorer bouclier/protection
      // et éviter toute fin de partie prématurée pendant la boucle : tout le monde perd, sans exception.
      const victims = Object.values(this.players).filter(p => p.alive);
      for (const v of victims) { v.alive = false; v.hp = 0; v.timesKO += 1; }
      affected = victims.map(v => ({ x: v.x, y: v.y }));
      this.pushLog("☢️ La bombe nucléaire n'épargne personne...");
      this.endGame([], "nuke");
    } else if (attack.target === "self" && attack.earthquake) {
      // Séisme : petits dégâts à tout le monde (y compris le lanceur), et chacun
      // est poussé d'une case dans une direction aléatoire si la place est libre.
      const victims = Object.values(this.players).filter(p => p.alive);
      const dirOptions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const v of victims) {
        this.applyDamage(player.id, v, attack.damage);
        if (!v.alive) continue;
        for (const [dx, dy] of shuffle(dirOptions)) {
          const nx = v.x + dx, ny = v.y + dy;
          if (!this.inBounds(nx, ny) || this.isBlocked(nx, ny)) continue;
          const occupied = Object.values(this.players).some(p => p.alive && p.id !== v.id && p.x === nx && p.y === ny);
          if (occupied) continue;
          v.x = nx; v.y = ny;
          break;
        }
      }
      affected = victims.map(v => ({ x: v.x, y: v.y }));
    } else if (attack.target === "self" && attack.instant && !attack.shield) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
    } else if (attack.target === "self" && attack.shield) {
      player.shield = true;
      affected = [{ x: player.x, y: player.y }];
    } else if (attack.target === "cell" && attack.instant && attack.subSize) {
      // Chute de napalme : un brasier 3x3 tourne façon moulinet dans les 4 coins
      // d'une zone 5x5 ancrée sur la case choisie (schéma fixe, aucun hasard de
      // position), et laisse des flammes derrière lui.
      let all = [];
      const grp = [];
      const offsets = attack.offsets || [[0, 0]];
      for (const [ox, oy] of offsets) {
        const cx = msg.x + ox, cy = msg.y + oy;
        const subCells = this.cellsForZone(cx, cy, attack.subSize);
        for (const c of subCells) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
        all = all.concat(subCells);
        grp.push(subCells);
        if (attack.leavesFire) {
          this.hazards.push({ type: "fire", x: cx, y: cy, size: attack.subSize, damage: attack.fireDamage || 7, ticks: attack.fireTicks || 4, ownerId: player.id });
        }
      }
      affected = all.concat(this.triggerBarrelChain(player.id, all));
      groups = grp;
    } else if (attack.target === "zone" && attack.random && attack.instant) {
      const zone = this.cellsForZone(msg.x, msg.y, attack.size);
      const picks = [];
      for (let i = 0; i < (attack.hits || 1); i++) picks.push(zone[randInt(zone.length)]);
      for (const c of picks) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = picks.concat(this.triggerBarrelChain(player.id, picks));
      groups = picks.map(c => [c]);
    } else if (attack.target === "ally") {
      const targetId = msg.targetId || player.id;
      const target = this.players[targetId];
      if (target && target.alive) {
        const dist = Math.abs(target.x - player.x) + Math.abs(target.y - player.y);
        if (target.id === player.id || dist <= 2) { this.applyHeal(target, attack.heal); affected = [{ x: target.x, y: target.y }]; }
      }
    }
    return { cells: affected, groups };
  }

  hillTick() {
    if (this.status !== "playing" || this.mode !== "kingHill") { clearInterval(this.hillTimer); return; }
    let changed = false;
    for (const p of Object.values(this.players)) {
      if (p.alive && this.onHill(p.x, p.y)) { p.score += 1; changed = true; }
    }
    if (changed) {
      this.broadcast(this.publicState());
      this.checkWinCondition();
    }
  }

  // ---- IA simple du bot (mode Boss) : se rapproche du joueur le plus proche
  // et utilise son arme automatiquement, avec un petit délai façon "réflexion". ----
  maybeBotAct() {
    const stillInCountdown = Date.now() - this.matchStartedAt < BOT_START_GRACE_MS;
    for (const bot of Object.values(this.players).filter(p => p.isBot && p.alive)) {
      if (stillInCountdown) continue; // reste immobile pendant le "3, 2, 1, GO !"

      this.botTryDodge(bot);
      const rooted = bot.rootedUntil && Date.now() < bot.rootedUntil;
      const fled = rooted ? false : this.botTryFlee(bot);

      if (!fled && !rooted) {
        const target = this.nearestAliveExcluding(bot.x, bot.y, new Set([bot.id]));
        if (target) {
          const dx = Math.sign(target.x - bot.x), dy = Math.sign(target.y - bot.y);
          const moves = [];
          if (dx !== 0) moves.push({ x: bot.x + dx, y: bot.y });
          if (dy !== 0) moves.push({ x: bot.x, y: bot.y + dy });
          for (const m of shuffle(moves)) this.handleMove(bot, m);
        }
      }

      if (this.turn && this.turn.playerId === bot.id && !bot._botActionPending) {
        bot._botActionPending = true;
        const [minMs, maxMs] = BOT_ATTACK_DELAY_MS[bot.botDifficulty || "medium"];
        const handle = setTimeout(() => {
          bot._botActionPending = false;
          this.pendingAttacks.delete(handle);
          if (this.status === "playing" && this.turn && this.turn.playerId === bot.id) this.botFireAttack(bot);
        }, minMs + randInt(maxMs - minMs));
        if (handle.unref) handle.unref();
        this.pendingAttacks.add(handle);
      }
    }
  }

  // Tente d'esquiver les attaques téléphonées en cours, selon la difficulté du bot.
  // Le tirage au sort (esquive ou non) n'a lieu qu'une fois par télégraphe ; une fois
  // décidé à fuir, le bot continue de s'éloigner du centre du danger à chaque tick.
  botTryDodge(bot) {
    if (!this.activeTelegraphs.length) return;
    for (const tg of this.activeTelegraphs) {
      const inDanger = tg.cells.some(c => c.x === bot.x && c.y === bot.y);
      if (!tg.dodgeRoll) tg.dodgeRoll = new Map();
      if (!tg.dodgeRoll.has(bot.id)) {
        const chance = BOT_DODGE_CHANCE[bot.botDifficulty || "medium"];
        tg.dodgeRoll.set(bot.id, inDanger && Math.random() < chance);
      }
      if (!inDanger || !tg.dodgeRoll.get(bot.id)) continue;

      const cx = tg.cells.reduce((s, c) => s + c.x, 0) / tg.cells.length;
      const cy = tg.cells.reduce((s, c) => s + c.y, 0) / tg.cells.length;
      const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => ({ x: bot.x + dx, y: bot.y + dy }))
        .filter(m => this.inBounds(m.x, m.y) && !this.isBlocked(m.x, m.y));
      if (!candidates.length) continue;
      candidates.sort((a, b) => Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy));
      this.handleMove(bot, candidates[0]); // s'éloigne autant que possible du centre du danger
    }
  }

  // Fuit une zone dangereuse (hors zone qui rétrécit, poison/feu/givre) ou une
  // attaque de mêlée sur le point d'être utilisée à proximité — selon la difficulté.
  // Retourne true si le bot a effectivement tenté de fuir ce tick.
  botTryFlee(bot) {
    const chance = BOT_DODGE_CHANCE[bot.botDifficulty || "medium"];
    if (Math.random() > chance) return false;

    if (this.shrinkEnabled && this.isVoid(bot.x, bot.y)) {
      const c = this.shrinkCenter();
      this.botStepToward(bot, c.x, c.y);
      return true;
    }
    const hazard = this.hazards.find(h =>
      (h.type === "poison" || h.type === "fire" || h.type === "frost") &&
      this.cellsForZone(h.x, h.y, h.size).some(c => c.x === bot.x && c.y === bot.y));
    if (hazard) { this.botStepAway(bot, hazard.x, hazard.y); return true; }

    if (this.turn && this.turn.playerId !== bot.id && BOT_FLEE_ATTACKS.has(this.turn.attack.id)) {
      const attacker = this.players[this.turn.playerId];
      if (attacker && attacker.alive) {
        const dist = Math.abs(attacker.x - bot.x) + Math.abs(attacker.y - bot.y);
        if (dist <= 3) { this.botStepAway(bot, attacker.x, attacker.y); return true; }
      }
    }
    return false;
  }

  botStepToward(bot, tx, ty) {
    const dx = Math.sign(tx - bot.x), dy = Math.sign(ty - bot.y);
    const moves = [];
    if (dx !== 0) moves.push({ x: bot.x + dx, y: bot.y });
    if (dy !== 0) moves.push({ x: bot.x, y: bot.y + dy });
    for (const m of shuffle(moves)) this.handleMove(bot, m);
  }

  botStepAway(bot, fromX, fromY) {
    let dx = Math.sign(bot.x - fromX), dy = Math.sign(bot.y - fromY);
    if (dx === 0 && dy === 0) { dx = randInt(2) ? 1 : -1; dy = randInt(2) ? 1 : -1; }
    const moves = [];
    if (dx !== 0) moves.push({ x: bot.x + dx, y: bot.y });
    if (dy !== 0) moves.push({ x: bot.x, y: bot.y + dy });
    for (const m of shuffle(moves)) this.handleMove(bot, m);
  }

  botFireAttack(bot) {
    const attack = this.turn.attack;
    const target = this.nearestAliveExcluding(bot.x, bot.y, new Set([bot.id])) || bot;
    let msg = { x: target.x, y: target.y };
    if (attack.target === "direction") {
      const dx = target.x - bot.x, dy = target.y - bot.y;
      msg = { dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy >= 0 ? "down" : "up") };
    } else if (attack.target === "line") {
      msg.axis = Math.abs(target.x - bot.x) > Math.abs(target.y - bot.y) ? "row" : "col";
    } else if (attack.target === "ally") {
      msg = { targetId: bot.id }; // simplicité : le bot se soigne lui-même
    }
    this.handleAttack(bot, msg);
  }

  secondTick() {
    if (this.status !== "playing") return;

    this.purgeStaleDisconnected();
    this.maybeBotAct();

    for (const p of Object.values(this.players)) {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) {
        const spawn = this.freeSpawn();
        p.alive = true; p.hp = Math.round(this.startingHP * (this.respawnHpPercent / 100)); p.x = spawn.x; p.y = spawn.y; p.respawnAt = null;
        p.invulnUntil = this.spawnProtectionSec > 0 ? Date.now() + this.spawnProtectionSec * 1000 : null;
        this.pushLog(`${p.pseudo} revient dans l'arène.`);
      }
    }

    if (this.passiveRegenPerSec > 0) {
      for (const p of Object.values(this.players)) {
        if (p.alive && p.hp < this.startingHP) this.applyHeal(p, this.passiveRegenPerSec);
      }
    }

    this.hazards = this.hazards.filter(h => {
      if (h.type !== "poison" && h.type !== "frost" && h.type !== "fire" && h.type !== "healzone") return true;
      const cells = this.cellsForZone(h.x, h.y, h.size);
      const owner = h.ownerId ? this.players[h.ownerId] : null;
      for (const p of Object.values(this.players)) {
        if (!p.alive || !cells.some(c => c.x === p.x && c.y === p.y)) continue;
        if (h.type === "healzone") {
          if (this.teamsEnabled && owner && owner.team && p.team !== owner.team) continue; // ne soigne pas les ennemis
          this.applyHeal(p, h.heal);
        } else {
          this.applyDamage(h.ownerId, p, h.damage);
          if (h.type === "frost" && p.alive) p.slowedUntil = Date.now() + (h.slowMs || 1500);
        }
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
      if (this.status !== "playing") return;
    }

    if (this.powerupsEnabled) {
      const intervalMs = this.powerupIntervalSec * 1000;
      if (Date.now() - this.lastPowerupSpawn >= intervalMs && this.powerups.length < this.powerupMaxOnMap) {
        const spot = this.freeSpawn();
        const type = POWERUP_TYPES[randInt(POWERUP_TYPES.length)];
        this.powerups.push({ id: crypto.randomUUID(), x: spot.x, y: spot.y, type });
        this.lastPowerupSpawn = Date.now();
      }
    }

    this.broadcast(this.publicState());
  }

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

  pickNextAttacker() {
    while (this.turnQueue.length) {
      const id = this.turnQueue.shift();
      const p = this.players[id];
      if (p && p.alive) return p;
    }
    const alive = Object.values(this.players).filter(p => p.alive).map(p => p.id);
    if (alive.length === 0) return null;
    this.turnQueue = shuffle(alive);
    const id = this.turnQueue.shift();
    return this.players[id] || null;
  }

  // Tirage pondéré : la plupart des armes ont un poids de 1 (probabilité normale),
  // les armes rarissimes (napalm, pluie acide) ont un poids très inférieur à 1.
  pickWeightedAttack() {
    const weightFor = (a) => {
      const base = a.weight !== undefined ? a.weight : 1;
      const override = this.attackWeightOverrides[a.id];
      return override !== undefined ? base * override : base;
    };
    const total = this.attacksRuntime.reduce((s, a) => s + weightFor(a), 0);
    if (total <= 0) return this.attacksRuntime[randInt(this.attacksRuntime.length)]; // repli si l'hôte a tout mis à 0%
    let r = Math.random() * total;
    for (const a of this.attacksRuntime) {
      const w = weightFor(a);
      if (r < w) return a;
      r -= w;
    }
    return this.attacksRuntime[this.attacksRuntime.length - 1];
  }

  tick() {
    if (this.status !== "playing") return;
    const now = Date.now();

    if (this.mode === "chrono" && this.chronoEndAt && now >= this.chronoEndAt && !this.suddenDeath) {
      this.resolveChronoEnd();
      if (this.status !== "playing") return;
      this.scheduleTick(this.turnGapSec * 1000);
      return;
    }

    if (this.turn && now > this.turn.deadline) {
      const p = this.players[this.turn.playerId];
      this.pushLog(`${p ? p.pseudo : "Le joueur"} n'a pas utilisé son arme à temps.`);
      this.turn = null;
      this.broadcast(this.publicState());
      this.scheduleTick(this.turnGapSec * 1000);
      return;
    }

    if (!this.turn) {
      const chosen = this.pickNextAttacker();
      if (!chosen) { this.scheduleTick(1000); return; }
      let attack;
      if (chosen.forcedNextAttackId) {
        attack = this.attacksRuntime.find(a => a.id === chosen.forcedNextAttackId) || ATTACKS.find(a => a.id === chosen.forcedNextAttackId);
        chosen.forcedNextAttackId = null;
      } else {
        attack = this.pickWeightedAttack();
        if (this.weaponNoRepeat && this.attacksRuntime.length > 1) {
          let guard = 0;
          while (attack.id === this.lastAttackId && guard < 10) { attack = this.pickWeightedAttack(); guard++; }
        }
      }
      this.lastAttackId = attack.id;
      const deadline = Date.now() + this.attackWindowSec * 1000;
      this.turn = { playerId: chosen.id, attack, deadline };
      // Charge : un peu plus vif tant qu'on l'a en main, pour repositionner son élan.
      if (attack.id === "charge") chosen.speedUntil = Math.max(chosen.speedUntil || 0, deadline);
      this.pushLog(`${chosen.pseudo} reçoit : ${attack.name} !`);
      this.broadcast(this.publicState());
      this.scheduleTick(this.attackWindowSec * 1000 + 200);
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
          maxPlayers: room.maxPlayers,
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
    const color = url.searchParams.get("color") || null;
    const avatarEmoji = url.searchParams.get("avatarEmoji") || null;
    if (!code) { ws.close(1008, "code manquant"); return; }

    const room = getOrCreateRoom(code);
    const player = room.addPlayer(ws, pseudo, clientId, { color, avatarEmoji });
    if (!player) { ws.send(JSON.stringify({ type: "error", message: "Partie pleine." })); ws.close(1008, "full"); return; }

    ws.send(JSON.stringify({
      type: "welcome", playerId: player.id, code: room.code, modes: MODES, maps: MAPS,
      attacks: ATTACKS.filter(a => !a.secret).map(a => ({ id: a.id, name: a.name, weight: a.weight !== undefined ? a.weight : 1, tunables: getAttackTunables(a) })),
    }));
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
      } else if (msg.type === "setMaxPlayers" && player.id === room.hostId && room.status === "lobby") {
        room.maxPlayers = clamp(parseInt(msg.value) || MAX_PLAYERS_HARD_CAP, 2, MAX_PLAYERS_HARD_CAP);
        room.syncBotFill();
        room.broadcast(room.publicState());
      } else if (msg.type === "setFillBots" && player.id === room.hostId && room.status === "lobby") {
        room.fillWithBots = !!msg.enabled;
        if (BOT_DIFFICULTIES.includes(msg.difficulty)) room.fillBotDifficulty = msg.difficulty;
        room.syncBotFill();
        room.broadcast(room.publicState());
      } else if (msg.type === "kickPlayer" && player.id === room.hostId && msg.targetId !== room.hostId) {
        room.kickPlayer(msg.targetId);
      } else if (msg.type === "transferHost" && player.id === room.hostId && msg.targetId !== room.hostId) {
        room.transferHost(msg.targetId);
      } else if (msg.type === "cheatCode" && room.status === "playing") {
        room.handleCheatCode(p, msg);
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

module.exports = { Room, MODES, MAPS, ATTACKS, DEFAULT_GRID_SIZE, RECONNECT_GRACE_MS, MAX_PLAYERS_HARD_CAP };
