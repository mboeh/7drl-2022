import * as ROT from "rot-js";

/// Random value generation

// represents an NdS+M dice roll with modifier
type Roll = {
  n: number;
  sides: number;
  mod: number;
};

// "Vermin" creatures always spawn with 1 HP, this is a shorthand
const verminHP: Roll = { n: 1, sides: 1, mod: 0 };

function asRoll(n: number, sides: number, mod: number): Roll {
  return { n, sides, mod };
}

function doRoll(roll: Roll): number {
  let n = 0;
  for (let i = 0; i < roll.n; i += 1) {
    n += ROT.RNG.getUniformInt(1, roll.sides);
  }
  return n + roll.mod;
}

/// Character graphics

const Glyphs = {
  player: "@",
  wall: "#",
  floor: ".",
  rock: ".",
  insect: "i",
  worm: "w",
};

type GlyphID = keyof typeof Glyphs;

/// Map tiles

type Tile = {
  glyph: GlyphID;
  blocks: boolean;
};

const Tiles: { [name: string]: Tile } = {
  rock: { glyph: "rock", blocks: true },
  wall: { glyph: "wall", blocks: true },
  floor: { glyph: "floor", blocks: false },
};

/// Monster data

type MonsterArchetype = {
  name: string;
  danger: number;
  glyph: GlyphID;
  appearing: Roll;
  hp: Roll;
};

const MonsterArchetypes: { [id: string]: MonsterArchetype } = {
  maggot: {
    name: "maggot heap",
    danger: 1,
    glyph: "worm",
    appearing: asRoll(1, 4, 3),
    hp: verminHP,
  },
  gnatSwarm: {
    name: "gnat swarm",
    danger: 1,
    glyph: "insect",
    appearing: asRoll(2, 4, 0),
    hp: verminHP,
  },
};

type ArchetypeID = keyof typeof MonsterArchetypes;

type Monster = {
  archetype: ArchetypeID;
  hp: number;
};

function spawnMonster(archetype: ArchetypeID): Monster {
  return {
    archetype,
    hp: doRoll(MonsterArchetypes[archetype].hp),
  };
}

type RememberedCell = readonly [Tile | null, ArchetypeID | null];

const DeathMessages: { [type: string]: string } = {
  drain: "%S crumbles into dust.",
};

type DeathType = keyof typeof DeathMessages;

/// Game commands

const Commands: { [key: string]: Function } = {
  h: movePlayer(-1, 0),
  l: movePlayer(1, 0),
  j: movePlayer(0, 1),
  k: movePlayer(0, -1),
  d: () => {
    let c = contentsAt(Game.player.x, Game.player.y);
    if (c.monster) {
      let arch = MonsterArchetypes[c.monster.archetype];
      if (c.monster.hp > 1) {
        msg.angry("The wretched creature resists!");
      } else {
        msg.log("You devour the essence of %s.", describe(c));
        Game.player.essence += arch.danger;
        killMonsterAt(c, "drain");
      }
    } else {
      msg.think("Nothing is here to drain of essence.");
    }
  },
};

/// Game state

const Game = {
  viewport: {
    width: 30,
    height: 30,
  },
  player: {
    x: 10,
    y: 10,
    essence: 0,
    energy: 1.0,
    glyph: "player" as GlyphID,
    knownMonsters: {} as { [id: ArchetypeID]: boolean },
  },
  map: {
    danger: 5,
    w: 80,
    h: 80,
    tiles: [] as Array<Tile>,
    monsters: [] as Array<Monster | null>,
    memory: [] as Array<RememberedCell>,
    fov: new ROT.FOV.PreciseShadowcasting((x, y) => {
      let c = contentsAt(x, y);
      // Nothing but tiles block FOV (for now)
      return !(!c.tile || c.tile.blocks);
    }),
  },
  commandQueue: [] as Array<keyof typeof Commands>,
  uiCallback: () => {},
  logCallback: (msg: string, msgType: string | undefined) => {},
};

// Initialize a new map

type NewMapOptions = {
  w?: number;
  h?: number;
  danger?: number;
};

function newMap(opts?: NewMapOptions) {
  // Erase the existing map
  Game.map.tiles = [];
  Game.map.monsters = [];
  Game.map.memory = [];

  // Update map properties
  if (opts) {
    Game.map = {
      ...Game.map,
      ...opts,
    };
  }

  // Fill in an empty map
  Game.map.tiles.fill(Tiles.rock, 0, Game.map.h * Game.map.w);
  Game.map.monsters.fill(null, 0, Game.map.w * Game.map.h);
  Game.map.memory.fill([null, null], 0, Game.map.w * Game.map.h);

  // Dig a new map
  let map = new ROT.Map.Digger(Game.map.w, Game.map.h);
  map.create();

  // Create rooms
  let rooms = map.getRooms();
  for (let room of rooms) {
    room.create((x, y, v) => {
      Game.map.tiles[x + y * Game.map.w] = v === 1 ? Tiles.wall : Tiles.floor;
    });
  }

  // Place the PC in the center of a random room
  rooms = ROT.RNG.shuffle(rooms);
  const startRoom = rooms.shift()!;
  const [px, py] = startRoom.getCenter();
  Game.player.x = px;
  Game.player.y = py;

  // Place monsters in other rooms
  const eligibleMonsters = Object.keys(MonsterArchetypes).filter(
    (id) => MonsterArchetypes[id].danger <= Game.map.danger
  );
  for (let room of rooms) {
    const mArch = ROT.RNG.getItem(eligibleMonsters)!;
    let appearing = doRoll(MonsterArchetypes[mArch].appearing);
    while (appearing > 0) {
      let mx = ROT.RNG.getUniformInt(room.getLeft(), room.getRight());
      let my = ROT.RNG.getUniformInt(room.getTop(), room.getBottom());
      let c = contentsAt(mx, my);
      if (!c.blocked) {
        Game.map.monsters[mx + my * Game.map.w] = spawnMonster(mArch);
      }
      appearing -= 1;
    }
  }

  // Create corridors
  for (let corridor of map.getCorridors()) {
    corridor.create((x, y, v) => {
      Game.map.tiles[x + y * Game.map.w] = Tiles.floor;
    });
  }
}

// Reading map contents

type XYContents = {
  x: number;
  y: number;
  tile: Tile | null;
  monster: Monster | null;
  player: boolean;
  blocked: boolean;
  memory: RememberedCell;
};

function tileAt(x: number, y: number): Tile | null {
  return Game.map.tiles[x + y * Game.map.w];
}

function monsterAt(x: number, y: number): Monster | null {
  return Game.map.monsters[x + y * Game.map.w];
}

function playerAt(x: number, y: number): boolean {
  return Game.player.x === x && Game.player.y === y;
}

function contentsAt(x: number, y: number): XYContents {
  let tile = tileAt(x, y);
  let monster = monsterAt(x, y);
  let player = playerAt(x, y);
  let archetype = monster?.archetype || null;
  let blocked = player;
  if (tile?.blocks) {
    blocked = true;
  }
  // You can phase through vermin and weakened enemies.
  if (monster && monster.hp > 1) {
    blocked = true;
  }
  return {
    x,
    y,
    tile,
    monster,
    player,
    blocked,
    memory: [tile, archetype],
  };
}

function describe(c: XYContents): string {
  if (c.monster) {
    return "a " + MonsterArchetypes[c.monster.archetype].name;
  } else {
    return "something";
  }
}

function killMonsterAt(c: XYContents, death: DeathType) {
  if (c.monster) {
    c.monster.hp = 0;
    msg.log(DeathMessages[death], describe(c));
    Game.map.monsters[c.x + c.y * Game.map.w] = null;
  }
}

// Updating game state

function tick() {
  if (Game.commandQueue.length == 0) {
    return;
  }
  while (Game.player.energy >= 1.0) {
    let nextCommand = Game.commandQueue.shift();
    if (nextCommand) {
      Commands[nextCommand]();
      Game.uiCallback();
    } else {
      break;
    }
  }
  if (Game.player.energy < 1.0) {
    Game.player.energy += 1.0;
  }
  Game.uiCallback();
}

function movePlayer(dx: number, dy: number) {
  return () => {
    const p = Game.player;
    const nx = p.x + dx;
    const ny = p.y + dy;
    const c = contentsAt(nx, ny);
    if (!c.blocked) {
      p.x = nx;
      p.y = ny;
      p.energy -= 1.0;
      if (c.monster) {
        msg.log("You feel the essence of %s awaiting your grasp.", describe(c));
        if (!Game.player.knownMonsters[c.monster.archetype]) {
          Game.player.knownMonsters[c.monster.archetype] = true;
          let archetype = MonsterArchetypes[c.monster.archetype];
          if (archetype.danger === 1) {
            msg.angry("Petty vermin!");
          }
        }
      }
    } else {
      if (c.monster) {
        msg.think("My way is blocked by %s.", describe(c));
      } else {
        msg.think("There is no passing this way.");
      }
    }
  };
}

/// Game transcript
function mkSay(type: string): Function {
  return (fmt: string, ...args: any[]) => {
    Game.logCallback(ROT.Util.format(fmt, ...args), type);
  };
}

const msg: { [type: string]: Function } = {
  log: mkSay("normal"),
  think: mkSay("thought"),
  angry: mkSay("angry"),
};

/// Input handling

function handleInput() {
  document.addEventListener("keypress", (e) => {
    let command = Commands[e.key];
    if (command) {
      Game.commandQueue.push(e.key);
      setTimeout(tick, 0);
    }
  });
}

/// Graphics

function drawMap(display: ROT.Display) {
  display.clear();

  let sx = Game.player.x - Game.viewport.width / 2;
  let sy = Game.player.y - Game.viewport.height / 2;

  if (sx < 0) {
    sx = 0;
  }
  if (sy < 0) {
    sy = 0;
  }
  // Draw remembered tiles
  for (let ix = 0; ix < Game.viewport.width; ix += 1) {
    for (let iy = 0; iy < Game.viewport.height; iy += 1) {
      let mem = Game.map.memory[sx + ix + (sy + iy) * Game.map.w];
      if (mem) {
        let [mtile, mmons] = mem;
        if (mmons) {
          display.draw(
            ix,
            iy,
            Glyphs[MonsterArchetypes[mmons].glyph],
            "#666",
            "#000"
          );
        } else if (mtile) {
          display.draw(ix, iy, Glyphs[mtile.glyph], "#666", "#000");
        }
      }
    }
  }
  // Draw seen tiles
  Game.map.fov.compute(
    Game.player.x,
    Game.player.y,
    Game.viewport.width / 2,
    (x, y, r, v) => {
      if (x < sx) {
        return;
      }
      if (y < sy) {
        return;
      }
      let c = contentsAt(x, y);
      Game.map.memory[x + y * Game.map.w] = c.memory;
      if (c.player) {
        display.draw(x - sx, y - sy, Glyphs[Game.player.glyph], "#ccc", "#111");
      } else if (c.monster) {
        display.draw(
          x - sx,
          y - sy,
          Glyphs[MonsterArchetypes[c.monster.archetype].glyph],
          "#eee",
          "#111"
        );
      } else if (c.tile) {
        display.draw(x - sx, y - sy, Glyphs[c.tile.glyph], "#999", "#111");
      } else {
        display.draw(x - sx, y - sy, Glyphs.rock, "#000", "#000");
      }
    }
  );
}

// Initializes the game state and begins rendering to a ROT.js canvas.
function runGame() {
  // Set up the ROT.js playfield
  let playarea = document.getElementById("playarea")!;
  let messages = document.getElementById("messages")!;
  let display = new ROT.Display(Game.viewport);
  let dispC = display.getContainer()!;
  playarea.appendChild(dispC);
  let logEl = document.createElement("ul");
  logEl.className = "messageLog";
  messages.appendChild(logEl);
  let logMessages: Array<[string, string]> = [];
  Game.uiCallback = () => {
    // Draw the map
    drawMap(display);
    // Update message log
    if (logMessages.length > 0) {
      let logLine = document.createElement("li");
      for (let [msg, msgType] of logMessages) {
        let msgEl = document.createElement("span");
        msgEl.className = "msg-" + msgType;
        msgEl.innerHTML = msg + " ";
        logLine.appendChild(msgEl);
      }
      logEl.prepend(logLine);
      logMessages.length = 0;
    }
    // Update stat view
    document.getElementById("essence")!.innerText =
      Game.player.essence.toString();
  };
  Game.logCallback = (msg: string, msgType: string | undefined) => {
    if (!msgType) {
      msgType = "info";
    }
    logMessages.push([msg, msgType]);
  };
  handleInput();

  newMap();
  Game.uiCallback();
}

window.onload = runGame;