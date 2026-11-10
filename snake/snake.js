const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ---- 迷宫尺寸（可通过设置切换） ----
// canvas 保持 500×500，通过 CELL 动态适配格子数
let COLS = 25;
let ROWS = 25;
let CELL = canvas.width / COLS;

// ---- Hamiltonian cycle ----
// 偶×偶：完美覆盖全网格；奇×奇：用 (N-1)×(N-1) 子区域 + 外部逃生带
let HAMW, HAMH;
let hamCycle, HAM_N, hamCycleIdx;

function rebuildHamiltonian() {
  HAMW = COLS % 2 === 0 ? COLS : COLS - 1;
  HAMH = ROWS % 2 === 0 ? ROWS : ROWS - 1;
  hamCycle = (function buildHam() {
    const c = [];
    // Row 0: rightward, x=0..HAMW-1
    for (let x = 0; x < HAMW; x++) c.push({ x, y: 0 });
    // Rows 1..HAMH-2: boustrophedon columns 1..HAMW-1
    for (let y = 1; y <= HAMH - 2; y++) {
      if (y % 2 === 1) {
        for (let x = HAMW - 1; x >= 1; x--) c.push({ x, y });
      } else {
        for (let x = 1; x < HAMW; x++) c.push({ x, y });
      }
    }
    // Row HAMH-1: leftward, x=HAMW-1..0
    for (let x = HAMW - 1; x >= 0; x--) c.push({ x, y: HAMH - 1 });
    // Column 0 upward: y=HAMH-2..1
    for (let y = HAMH - 2; y >= 1; y--) c.push({ x: 0, y });
    return c;
  })();
  HAM_N = hamCycle.length;
  hamCycleIdx = new Map();
  for (let i = 0; i < HAM_N; i++) {
    hamCycleIdx.set(`${hamCycle[i].x},${hamCycle[i].y}`, i);
  }
}
rebuildHamiltonian();

// 切换网格尺寸并重建 Hamiltonian 循环
function setGridSize(n) {
  COLS = n;
  ROWS = n;
  CELL = canvas.width / n;
  rebuildHamiltonian();
}

// 该点是否在 Hamiltonian 主区域内
function inHamArea(x, y) {
  return x >= 0 && x < HAMW && y >= 0 && y < HAMH;
}

// ---- 状态 ----
let snake, dir, nextDir, food, score, best = 0;
let gameState = 'idle'; // idle | running | paused | over | replaying | replay-paused
let fps = 10;
let baseFps = 10;
const FPS_CAP = 60;            // 自动加速上限；达到后蛇头变橙色
let autoSpeed = false;
let demoMode  = false;
let demoTimeout = null;
let lastTime = 0;
let elapsedSeconds = 0;
let timerInterval = null;
let gameStartWallTime = 0;
let animId = null;

// ---- Replay 状态 ----
let replayEntries = null;    // 待回放的足迹条目数组
let replayIndex = 0;         // 已回放到第几条
let replayFps = 30;          // 回放帧率（默认极速 30fps）

// ---- UI refs ----
const overlay          = document.getElementById('overlay');
const overlayTitle     = document.getElementById('overlay-title');
const overlayMsg       = document.getElementById('overlay-msg');
const btnStart         = document.getElementById('btn-start');
const btnReplay        = document.getElementById('btn-replay');
const btnOpenSettings  = document.getElementById('btn-open-settings');
const settingsPanel    = document.getElementById('settings-panel');
const btnCloseSettings  = document.getElementById('btn-close-settings');
const btnApplyRestart   = document.getElementById('btn-apply-restart');
const btnImportReplay   = document.getElementById('btn-import-replay');
const importFileInput   = document.getElementById('import-file-input');
const toggleAutoSpeed  = document.getElementById('toggle-autospeed');
const toggleDemo       = document.getElementById('toggle-demo');
const demoDurationSel  = document.getElementById('demo-duration');
let demoDurationSecs   = 60;
const gridSizeSel      = document.getElementById('grid-size');
const scoreEl          = document.getElementById('score');
const bestEl           = document.getElementById('best');
const fpsDisplayEl     = document.getElementById('fps-display');
const timerDisplayEl   = document.getElementById('timer-display');
const snakeXEl         = document.getElementById('snake-x');
const snakeYEl         = document.getElementById('snake-y');
const foodXEl          = document.getElementById('food-x');
const foodYEl          = document.getElementById('food-y');
const traceList        = document.getElementById('trace-list');
const btnSaveTrace     = document.getElementById('btn-save-trace');
const btnClearTrace    = document.getElementById('btn-clear-trace');

// ---- 足迹数据 ----
let traceLog = [];
let traceStep = 0;
const DIR_ICONS = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' };

function logTrace(head, d, ate, death) {
  traceStep++;
  const entry = {
    step: traceStep,
    x: head.x, y: head.y,
    dir: `${d.x},${d.y}`,
    ate,
    foodX: food.x, foodY: food.y,
    death: death || '',  // '' | 'wall' | 'self'
  };
  traceLog.push(entry);
  appendTraceItem(entry);
  traceList.scrollTop = traceList.scrollHeight;
}

function appendTraceItem(e) {
  const row = document.createElement('div');
  row.className = 'trace-item' + (e.ate ? ' ate' : '') + (e.death ? ' dead' : '');
  const icon = DIR_ICONS[e.dir] || '?';
  const deathTag = e.death === 'wall' ? '💥墙' : e.death === 'self' ? '💀身' : '';
  row.innerHTML =
    `<span class="ti-step">#${e.step}</span>` +
    `<span class="ti-coord">(${e.x},${e.y})</span>` +
    `<span class="ti-dir">${icon}</span>` +
    (e.ate ? `<span class="ti-food">🍎(${e.foodX},${e.foodY})</span>` : '') +
    (e.death ? `<span class="ti-food" style="color:#e03a7a">${deathTag}</span>` : '');
  traceList.appendChild(row);
}

function clearTrace() {
  traceLog = [];
  traceStep = 0;
  traceList.innerHTML = '';
}

btnClearTrace.addEventListener('click', clearTrace);

btnSaveTrace.addEventListener('click', () => {
  if (traceLog.length === 0) return;
  const lines = ['step,x,y,dir,ate,food_x,food_y,death'];
  traceLog.forEach(e => {
    lines.push(`${e.step},${e.x},${e.y},${e.dir},${e.ate ? 1 : 0},${e.foodX},${e.foodY},${e.death || ''}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `snake_trace_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- 配色 ----
const COLORS = {
  bg: '#f0fff4',
  gridLine: '#e0f0e5',
  snakeHead: '#00695c',
  snakeHeadStroke: '#004d40',
  snakeHeadMax: '#ff8c1a',       // 达到 FPS_CAP 时蛇头变橙色
  snakeHeadMaxStroke: '#c65a00',
  snakeBody: '#55efc4',
  snakeBodyStroke: '#00b894',
  snakeTail: '#b8f2dc',        // 蛇尾更淡的薄荷绿
  snakeTailStroke: '#8fd9b6',
  snakeEye: '#fff',
  snakePupil: '#2d3436',
  food: '#ff6b6b',
  foodStroke: '#c0392b',
  foodShine: 'rgba(255,255,255,0.55)',
  foodLeaf: '#55efc4',
};

// ---- 初始化 ----
function initGame() {
  // 初始蛇放在网格中心，横向 3 节
  const cx = Math.floor(COLS / 2);
  const cy = Math.floor(ROWS / 2);
  snake = [
    { x: cx,     y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ];
  dir = { x: 1, y: 0 };
  nextDir = { x: 1, y: 0 };
  score = 0;
  fps = baseFps;
  scoreEl.textContent = 0;
  fpsDisplayEl.textContent = fps;
  elapsedSeconds = 0;
  timerDisplayEl.textContent = '0:00';
  clearTrace();
  recentPositions = [];
  escapeTarget = null;
  escapeCountdown = 0;
  stuckSteps = 0;
  lastFoodKey = null;
  placeFood();
}

function placeFood() {
  // 食物限制在 Hamiltonian cycle 覆盖区域内（HAMW x HAMH），保证始终可达
  // 若 HAMW*HAMH 区域已被蛇占满 → 触发满盘胜利
  const bodySet = new Set(snake.map(s => `${s.x},${s.y}`));
  const freeCells = [];
  for (let y = 0; y < HAMH; y++) {
    for (let x = 0; x < HAMW; x++) {
      if (!bodySet.has(`${x},${y}`)) freeCells.push({ x, y });
    }
  }
  if (freeCells.length === 0) {
    // 满盘：不再放食物，进入胜利态
    food = { x: -1, y: -1 };
    gameWin();
    return;
  }
  food = freeCells[Math.floor(Math.random() * freeCells.length)];
}

// ---- AI演示 ----

// 循环检测：记录最近 N 步蛇头位置，判断是否形成重复轨迹
const LOOP_WINDOW = 40;
const LOOP_THRESHOLD = 10;
let recentPositions = [];
let stuckSteps = 0;         // 连续多少步没吃到食物
let escapeTarget = null;    // 卡住时锁定的临时探索目标
let escapeCountdown = 0;    // 目标锁定的剩余步数
let lastFoodKey = null;     // 上次食物位置，检测食物变化时清空 escape

function recordPosition(head) {
  recentPositions.push(`${head.x},${head.y}`);
  if (recentPositions.length > LOOP_WINDOW * 2) {
    recentPositions.shift();
  }
}

function isLooping() {
  if (recentPositions.length < LOOP_WINDOW) return false;
  const recent = recentPositions.slice(-LOOP_WINDOW);
  const unique = new Set(recent).size;
  // 唯一坐标数太少说明在反复经过相同格子
  return unique <= LOOP_THRESHOLD;
}

function breakLoopDir(head, bodyFull, bodyNoTail) {
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  // 优先选和当前方向垂直的，其次反方向以外的，避免继续循环
  const perpDirs = DIRS.filter(d =>
    d.x !== dir.x && d.y !== dir.y &&  // 垂直
    !(d.x === -dir.x && d.y === -dir.y) // 非反向
  );
  const allDirs = [...perpDirs, ...DIRS.filter(d =>
    !(d.x === dir.x && d.y === dir.y) && // 非当前
    !(d.x === -dir.x && d.y === -dir.y)  // 非反向
  )];

  let bestDir = null, bestSpace = -1;
  for (const d of allDirs) {
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyFull.has(`${nx},${ny}`)) continue;
    const space = floodFill({ x: nx, y: ny }, bodyNoTail);
    if (space > bestSpace) { bestSpace = space; bestDir = d; }
  }
  return bestDir;
}

// ---- AI 演示（Hamiltonian cycle + 安全 shortcut） ----
// 算法：
//   1. 默认沿 Hamiltonian cycle 前进（保证永不自撞）
//   2. 每步尝试 shortcut：如果某个邻居可以在不越过蛇尾的前提下更快接近食物
//      （即：邻居到食物的 cycle 距离 < 邻居到蛇尾的 cycle 距离），走 shortcut
//   3. 蛇越长，shortcut 越少，最终纯 cycle 保证安全
// ---- AI 演示（混合策略：BFS 直冲 + Hamiltonian 安全网） ----
// 策略：
//   1. 先尝试 BFS 最短路径到食物（快速吃食物）
//   2. 如果 BFS 路径通过 isSafeToEat 检查（吃完后仍有充裕空间），走这条路
//   3. 否则退化到 Hamiltonian cycle：默认跟随 cycle，尝试合法 shortcut
//   Hamiltonian cycle 保证蛇永不撞死，即使 BFS 拒绝所有食物路径
function aiNextDir() {
  const head = snake[0];
  const len = snake.length;
  const bodyFull = new Set(snake.map(s => `${s.x},${s.y}`));
  const bodyNoTail = new Set(snake.slice(0, snake.length - 1).map(s => `${s.x},${s.y}`));

  // --- 阶段 1：BFS 直冲食物 + 分级安全判据 ---
  //   stuckSteps < len：严格安全（吃完头能到尾 或 剩余空间 ≥ len）
  //   stuckSteps < 2*len：宽松（吃完至少有一个合法移动）
  //   stuckSteps ≥ 2*len：饥饿兜底，无视安全直接吃（避免"跟尾死循环"）
  const foodPath = bfsPath(head, food, bodyFull, snake);
  let chosen = null;
  if (foodPath && foodPath.length > 0) {
    let safeOK = false;
    if (len < 10) {
      safeOK = true;
    } else if (stuckSteps >= 2 * len) {
      // 饥饿兜底：允许绕过严格"追尾可达"安全判据，但**仍需保证吃完后至少有一个合法移动**。
      // 否则会走进"吃完必死"陷阱（15×15 长循环下的真实死因，14×14 邻居全被身体环绕）。
      safeOK = hasLegalMoveAfterEat(snake, foodPath);
    } else if (stuckSteps >= len) {
      safeOK = hasLegalMoveAfterEat(snake, foodPath);
    } else {
      safeOK = isSafeToEatByTail(snake, foodPath);
    }
    if (safeOK) {
      const next = foodPath[0];
      chosen = { x: next.x - head.x, y: next.y - head.y };
    }
  }

  // --- 阶段 2：追尾/求生（食物不可达 或 吃食物不安全） ---
  if (!chosen) {
    const chase = tailChaseOrSpace(head, snake, bodyNoTail, bodyFull);
    if (chase) {
      const nx = head.x + chase.x, ny = head.y + chase.y;
      const inGrid = nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS;
      if (inGrid && !bodyFull.has(`${nx},${ny}`)) chosen = chase;
    }
  }

  // --- 阶段 3：Hamiltonian 巡游（最后兜底） ---
  if (!chosen) chosen = hamiltonianNext(head);

  // --- 阶段 4：终极保险——任何撞墙/撞身方向都替换为最大空间生存移动 ---
  const nx = head.x + chosen.x, ny = head.y + chosen.y;
  const outOfGrid = nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS;
  const hitsBody = bodyFull.has(`${nx},${ny}`);
  if (outOfGrid || hitsBody) {
    const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    let bestD = null, bestSp = -1;
    for (const d of DIRS) {
      if (d.x === -dir.x && d.y === -dir.y) continue;
      const mx = head.x + d.x, my = head.y + d.y;
      if (mx < 0 || mx >= COLS || my < 0 || my >= ROWS) continue;
      if (bodyFull.has(`${mx},${my}`)) continue;
      const sp = floodFill({ x: mx, y: my }, bodyNoTail);
      if (sp > bestSp) { bestSp = sp; bestD = d; }
    }
    if (bestD) chosen = bestD;
  }

  return chosen;
}

// 严格判据：吃完食物后新头能 BFS 到新尾。
// 之前用过 "或 floodFill 空间 ≥ 长度" 的混合判据，但 floodFill 静态视角
// 会高估紧盘绕蛇的可用空间，接受致命路径（67 分复现证实），故回退到严格判据。
// 长时间没吃到食物时由 aiNextDir 中的 stuckSteps 分级机制放宽，避免死循环。
function isSafeToEatByTail(snakeArr, path) {
  const simSnake = simulateEat(snakeArr, path);
  const simHead = simSnake[0];
  const simTail = simSnake[simSnake.length - 1];
  const simFull = new Set(simSnake.map(s => `${s.x},${s.y}`));
  return bfsPath(simHead, simTail, simFull, simSnake) !== null;
}

// 吃完食物后至少还有一个合法移动 → 宽松判据（长时间饥饿时打破跟尾循环）
function hasLegalMoveAfterEat(snakeArr, path) {
  const simSnake = simulateEat(snakeArr, path);
  const simHead = simSnake[0];
  const simFull = new Set(simSnake.map(s => `${s.x},${s.y}`));
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  for (const d of DIRS) {
    const nx = simHead.x + d.x, ny = simHead.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (simFull.has(`${nx},${ny}`)) continue;
    return true;
  }
  return false;
}

// Hamiltonian cycle 决策：默认跟随 cycle，尝试合法 shortcut
function hamiltonianNext(head) {
  const tail = snake[snake.length - 1];
  const hi = hamCycleIdx.get(`${head.x},${head.y}`);
  const ti = hamCycleIdx.get(`${tail.x},${tail.y}`);
  const fi = hamCycleIdx.get(`${food.x},${food.y}`);

  // 头不在 cycle 内（可能因为直冲后暂时错位）→ 找一个能回到 cycle 的方向
  if (hi === undefined) {
    return returnToHamiltonianDir(head);
  }

  const defaultNext = hamCycle[(hi + 1) % HAM_N];
  // 若 cycle 的下一格恰好是当前方向的反向（非法转向），把 defaultNext 标记为
  // 无效——避免后续 shortcut/fallback 都失败时把反向送出去导致自撞。
  const defaultIsReverse = (defaultNext.x - head.x === -dir.x) && (defaultNext.y - head.y === -dir.y);
  let bestNext = defaultIsReverse ? null : defaultNext;
  let bestShortcut = 0;

  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const bodySet = new Set(snake.map(s => `${s.x},${s.y}`));
  const dfltDistFoodFromNext = (fi !== undefined && ti !== undefined)
    ? (fi - ((hi + 1) % HAM_N) + HAM_N) % HAM_N
    : 0;

  if (fi !== undefined && ti !== undefined) {
    for (const d of DIRS) {
      if (d.x === -dir.x && d.y === -dir.y) continue;
      const nx = head.x + d.x, ny = head.y + d.y;
      if (!inHamArea(nx, ny)) continue;
      if (bodySet.has(`${nx},${ny}`)) continue;
      const ni = hamCycleIdx.get(`${nx},${ny}`);
      if (ni === undefined) continue;

      const distFood = (fi - ni + HAM_N) % HAM_N;
      const distTail = (ti - ni + HAM_N) % HAM_N;
      if (distTail === 0) continue;
      if (distFood >= distTail) continue;

      const shortcut = dfltDistFoodFromNext - distFood;
      if (shortcut > bestShortcut) {
        bestShortcut = shortcut;
        bestNext = { x: nx, y: ny };
      }
    }
  }

  // 默认 cycle 下一格被身体占据 或 是非法反向（bestNext=null）→ 逐级降级找出路：
  //   Level 1: 在 Hamiltonian 区域内找非身体邻居
  //   Level 2: 允许外部逃生带（长蛇被困时的紧急避险）
  //   同时按 floodFill 空间从大到小挑选，避免走进死角
  const needFallback = bestNext === null || bodySet.has(`${bestNext.x},${bestNext.y}`);
  if (needFallback) {
    const noTailSet = new Set(snake.slice(0, snake.length - 1).map(s => `${s.x},${s.y}`));
    // Level 1: Hamiltonian 区域内
    let candL1 = null, spL1 = -1;
    for (const d of DIRS) {
      if (d.x === -dir.x && d.y === -dir.y) continue;
      const nx = head.x + d.x, ny = head.y + d.y;
      if (!inHamArea(nx, ny)) continue;
      if (bodySet.has(`${nx},${ny}`)) continue;
      const sp = floodFill({ x: nx, y: ny }, noTailSet);
      if (sp > spL1) { spL1 = sp; candL1 = { x: nx, y: ny }; }
    }
    if (candL1) {
      bestNext = candL1;
    } else {
      // Level 2: 全网格（含外部逃生带）
      let candL2 = null, spL2 = -1;
      for (const d of DIRS) {
        if (d.x === -dir.x && d.y === -dir.y) continue;
        const nx = head.x + d.x, ny = head.y + d.y;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        if (bodySet.has(`${nx},${ny}`)) continue;
        const sp = floodFill({ x: nx, y: ny }, noTailSet);
        if (sp > spL2) { spL2 = sp; candL2 = { x: nx, y: ny }; }
      }
      if (candL2) {
        bestNext = candL2;
      } else if (bestNext === null) {
        // 完全无路可退：保持当前方向（阶段 4 会兜底替换）
        bestNext = { x: head.x + dir.x, y: head.y + dir.y };
      }
      // Level 3: 无路可退 → 保持 bestNext 原样（会撞死，无解）
    }
  }

  return { x: bestNext.x - head.x, y: bestNext.y - head.y };
}

// 头位置不在 cycle 时（如已进入外部逃生带），走一步回到 Hamiltonian 区域
function returnToHamiltonianDir(head) {
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const bodySet = new Set(snake.map(s => `${s.x},${s.y}`));
  const noTailSet = new Set(snake.slice(0, snake.length - 1).map(s => `${s.x},${s.y}`));
  // 优先：能回到 Hamiltonian 区域，选空间最大的
  let backCand = null, backSp = -1;
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (!inHamArea(nx, ny)) continue;
    if (bodySet.has(`${nx},${ny}`)) continue;
    const sp = floodFill({ x: nx, y: ny }, noTailSet);
    if (sp > backSp) { backSp = sp; backCand = d; }
  }
  if (backCand) return backCand;
  // 次选：全网格内任意安全移动，选空间最大的（可能继续留在外部逃生带）
  let anyCand = null, anySp = -1;
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodySet.has(`${nx},${ny}`)) continue;
    const sp = floodFill({ x: nx, y: ny }, noTailSet);
    if (sp > anySp) { anySp = sp; anyCand = d; }
  }
  return anyCand || dir; // 无路可退
}

// 找一个"重排目标"：在可达空格中选距离食物曼哈顿最近的，
// 引导蛇朝食物方向走，而不是走到远角落
function findEscapeTarget(head, bodyFull) {
  const reachable = bfsReachableCells(head, bodyFull, snake);
  if (reachable.size <= 1) return null;

  let best = null;
  let bestFoodDist = Infinity;
  const minStepFromHead = Math.max(4, Math.floor(snake.length / 6));

  for (const key of reachable) {
    const [x, y] = key.split(',').map(Number);
    if (x === head.x && y === head.y) continue;
    const headDist = Math.abs(x - head.x) + Math.abs(y - head.y);
    if (headDist < minStepFromHead) continue;
    const foodDist = Math.abs(x - food.x) + Math.abs(y - food.y);
    if (foodDist < bestFoodDist) {
      bestFoodDist = foodDist;
      best = { x, y };
    }
  }
  return best;
}

// 返回从 start 可达的所有格子（使用时间感知 BFS，蛇尾会随步数释放）
function bfsReachableCells(start, bodySet, snakeArr) {
  const releaseTime = new Map();
  if (snakeArr) {
    const len = snakeArr.length;
    for (let i = 0; i < len; i++) {
      const k = `${snakeArr[i].x},${snakeArr[i].y}`;
      const t = len - i;
      releaseTime.set(k, Math.max(releaseTime.get(k) || 0, t));
    }
  }
  const key = p => `${p.x},${p.y}`;
  const queue = [{ pos: start, step: 0 }];
  const visited = new Set([key(start)]);
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  while (queue.length) {
    const { pos, step } = queue.shift();
    for (const d of DIRS) {
      const nx = pos.x + d.x, ny = pos.y + d.y;
      const nk = `${nx},${ny}`;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const nextStep = step + 1;
      if (bodySet.has(nk)) {
        const rt = releaseTime.get(nk);
        if (rt === undefined || rt >= nextStep) continue;
      }
      if (visited.has(nk)) continue;
      visited.add(nk);
      queue.push({ pos: { x: nx, y: ny }, step: nextStep });
    }
  }
  return visited;
}

function isSafeToEat(snakeArr, path, ratio) {
  const simSnake = simulateEat(snakeArr, path);
  const simNoTail = new Set(
    simSnake.slice(0, simSnake.length - 1).map(s => `${s.x},${s.y}`)
  );
  const free = floodFill(simSnake[0], simNoTail);
  return free >= simSnake.length * ratio;
}

function detourStep(head, foodPos, bodyNoTail, bodyFull) {
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const distToFood = (p) => Math.abs(p.x - foodPos.x) + Math.abs(p.y - foodPos.y);
  const curDist = distToFood(head);
  let bestDir = null, bestSpace = -1;
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyFull.has(`${nx},${ny}`)) continue;
    const newDist = distToFood({ x: nx, y: ny });
    if (newDist < curDist) continue;
    const space = floodFill({ x: nx, y: ny }, bodyNoTail);
    if (space > bestSpace) { bestSpace = space; bestDir = d; }
  }
  if (!bestDir) {
    for (const d of DIRS) {
      if (d.x === -dir.x && d.y === -dir.y) continue;
      const nx = head.x + d.x, ny = head.y + d.y;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      if (bodyFull.has(`${nx},${ny}`)) continue;
      const space = floodFill({ x: nx, y: ny }, bodyNoTail);
      if (space > bestSpace) { bestSpace = space; bestDir = d; }
    }
  }
  return bestDir;
}

function tailChaseOrSpace(head, snakeArr, bodyNoTail, bodyFull) {
  const tail = snakeArr[snakeArr.length - 1];
  const pathToTail = bfsPath(head, tail, bodyFull, snakeArr);
  const foodReachableNow = bfsPath(head, food, bodyFull, snakeArr);
  const len = snakeArr.length;

  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const validMoves = [];
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyFull.has(`${nx},${ny}`)) continue;

    const altSnake = [{ x: nx, y: ny }, ...snakeArr.slice(0, snakeArr.length - 1)];
    const altFull = new Set(altSnake.map(s => `${s.x},${s.y}`));
    const altNoTail = new Set(altSnake.slice(0, altSnake.length - 1).map(s => `${s.x},${s.y}`));

    // 空间 & 2 步后出路
    const space = floodFill({ x: nx, y: ny }, altNoTail);
    let hasEscape = false;
    for (const dd of DIRS) {
      if (dd.x === -d.x && dd.y === -d.y) continue;
      const nnx = nx + dd.x, nny = ny + dd.y;
      if (nnx < 0 || nnx >= COLS || nny < 0 || nny >= ROWS) continue;
      if (altFull.has(`${nnx},${nny}`)) continue;
      hasEscape = true;
      break;
    }

    // 走这一步后蛇尾是否还可追
    const altTail = altSnake[altSnake.length - 1];
    const tailStillReachable = bfsPath({ x: nx, y: ny }, altTail, altFull, altSnake) !== null;

    validMoves.push({ d, next: { x: nx, y: ny }, space, hasEscape, tailStillReachable });
  }

  if (validMoves.length === 0) return dir;

  // 先剔除"2 步后无出路"的死步（除非全部死步）
  const alive = validMoves.filter(m => m.hasEscape);
  const pool = alive.length > 0 ? alive : validMoves;

  // 若食物可达，优先选"食物仍可达 + 蛇尾可追 + 空间最大"
  if (foodReachableNow) {
    let best = null;
    for (const m of pool) {
      if (!m.tailStillReachable) continue;
      const altSnake = [m.next, ...snakeArr.slice(0, snakeArr.length - 1)];
      const altFull = new Set(altSnake.map(s => `${s.x},${s.y}`));
      if (!bfsPath(m.next, food, altFull, altSnake)) continue;
      if (!best || m.space > best.space) best = m;
    }
    if (best) return best.d;
  }

  // 食物不可达 或 上面找不到理想方向：优先"追尾方向 + 蛇尾可追"
  if (pathToTail && pathToTail.length > 0) {
    const tNext = pathToTail[0];
    const tailMove = pool.find(m => m.next.x === tNext.x && m.next.y === tNext.y);
    if (tailMove && tailMove.tailStillReachable) {
      return tailMove.d;
    }
  }

  // 兜底：从可存活方向中选空间最大的
  let bestSurv = null;
  for (const m of pool) {
    if (!m.tailStillReachable) continue;
    if (!bestSurv || m.space > bestSurv.space) bestSurv = m;
  }
  if (bestSurv) return bestSurv.d;

  // 蛇尾都追不到：单纯选空间最大
  let bestSpace = null;
  for (const m of pool) {
    if (!bestSpace || m.space > bestSpace.space) bestSpace = m;
  }
  return bestSpace.d;
}

function maxSpaceDir(head, bodyNoTail, bodyFull) {
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  let bestDir = null, bestSpace = -1;
  // 优先选：走后能到食物 且 空间最大
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyFull.has(`${nx},${ny}`)) continue;
    const altSnake = [{ x: nx, y: ny }, ...snake.slice(0, snake.length - 1)];
    const altFull = new Set(altSnake.map(s => `${s.x},${s.y}`));
    const altNoTail = new Set(altSnake.slice(0, altSnake.length - 1).map(s => `${s.x},${s.y}`));
    if (!bfsPath({ x: nx, y: ny }, food, altFull, altSnake)) continue;
    const space = floodFill({ x: nx, y: ny }, altNoTail);
    if (space > bestSpace) { bestSpace = space; bestDir = d; }
  }
  if (bestDir) return bestDir;

  // 次选：不要求到食物，只选空间最大
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyFull.has(`${nx},${ny}`)) continue;
    const space = floodFill({ x: nx, y: ny }, bodyNoTail);
    if (space > bestSpace) { bestSpace = space; bestDir = d; }
  }
  if (bestDir) return bestDir;

  // 兜底：bodyNoTail 可穿越
  for (const d of DIRS) {
    if (d.x === -dir.x && d.y === -dir.y) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
    if (bodyNoTail.has(`${nx},${ny}`)) continue;
    return d;
  }
  return dir;
}

function simulateEat(originalSnake, path) {
  let s = originalSnake.map(p => ({ ...p }));
  for (const step of path) {
    const eating = (step.x === food.x && step.y === food.y);
    s = [{ ...step }, ...s];
    if (!eating) s.pop();
  }
  return s;
}

function floodFill(start, bodySet) {
  const key = p => `${p.x},${p.y}`;
  const queue = [start];
  const visited = new Set([key(start)]);
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  while (queue.length) {
    const pos = queue.shift();
    for (const d of DIRS) {
      const nx = pos.x + d.x, ny = pos.y + d.y;
      const nk = `${nx},${ny}`;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      if (bodySet.has(nk) || visited.has(nk)) continue;
      visited.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }
  return visited.size;
}

function bfsPath(start, target, bodySet, snakeArr) {
  const key = p => `${p.x},${p.y}`;

  // 构建时间释放表：Map<格子key, 步数> 表示该格在第几步之后变为空闲
  // snakeArr[i] 在第 (len-i) 步离开（尾部最快，头部最慢）
  // 注意：同一格可能被蛇身多次占据（盘绕时），取最大释放时间
  const releaseTime = new Map();
  if (snakeArr) {
    const len = snakeArr.length;
    for (let i = 0; i < len; i++) {
      const k = `${snakeArr[i].x},${snakeArr[i].y}`;
      const t = len - i; // 第 t 步后该格释放（头=len步后，尾=1步后）
      if (!releaseTime.has(k) || releaseTime.get(k) > t) {
        // 同一坐标多次出现时取最大值（最晚释放）
        releaseTime.set(k, Math.max(releaseTime.get(k) || 0, t));
      }
    }
    // 修正：同一坐标多次出现需取最大释放时间（上面逻辑已处理）
  }

  const queue = [{ pos: start, path: [], step: 0 }];
  const visited = new Map();
  visited.set(key(start), 0);
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

  while (queue.length) {
    const { pos, path, step } = queue.shift();
    for (const d of DIRS) {
      const nx = pos.x + d.x, ny = pos.y + d.y;
      const nk = `${nx},${ny}`;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const nextStep = step + 1;
      if (bodySet.has(nk)) {
        // 只有当蛇身格的释放时间 < nextStep 时才允许通过
        const rt = releaseTime.get(nk);
        if (rt === undefined || rt >= nextStep) continue;
      }
      if (visited.has(nk)) continue;
      const newPath = [...path, { x: nx, y: ny }];
      if (nx === target.x && ny === target.y) return newPath;
      visited.set(nk, nextStep);
      queue.push({ pos: { x: nx, y: ny }, path: newPath, step: nextStep });
    }
  }
  return null;
}

function bfsReachable(start, target, bodySet) {
  const key = p => `${p.x},${p.y}`;
  const queue = [start];
  const visited = new Set([key(start)]);
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  while (queue.length) {
    const pos = queue.shift();
    if (pos.x === target.x && pos.y === target.y) return true;
    for (const d of DIRS) {
      const nx = pos.x + d.x, ny = pos.y + d.y;
      const nk = `${nx},${ny}`;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      if (bodySet.has(nk) || visited.has(nk)) continue;
      visited.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }
  return false;
}

// ---- 游戏循环 ----
function gameLoop(ts) {
  animId = requestAnimationFrame(gameLoop);
  // 回放状态：只按 replayFps 节奏推进 replay
  if (gameState === 'replaying') {
    if (ts - lastTime < 1000 / replayFps) return;
    lastTime = ts;
    return replayStep();
  }
  if (gameState !== 'running') return;
  if (ts - lastTime < 1000 / fps) return;
  lastTime = ts;

  if (demoMode) nextDir = aiNextDir();

  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  // 碰墙：先记录致命步（标记 death=wall）再结束
  if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
    logTrace(head, dir, false, 'wall');
    return gameOver();
  }
  // 碰自身：先记录致命步（标记 death=self）再结束
  if (snake.some(s => s.x === head.x && s.y === head.y)) {
    logTrace(head, dir, false, 'self');
    return gameOver();
  }

  snake.unshift(head);

  const ate = (head.x === food.x && head.y === food.y);
  logTrace(head, dir, ate);

  if (ate) {
    score++;
    scoreEl.textContent = score;
    if (score > best) { best = score; bestEl.textContent = best; }
    if (autoSpeed && score % 10 === 0) {
      fps = Math.min(FPS_CAP, baseFps + Math.floor(score / 10));
      fpsDisplayEl.textContent = fps;
    }
    stuckSteps = 0; // 吃到食物，重置卡住计数
    placeFood();
  } else {
    stuckSteps++;
    snake.pop();
    // 循环走 3 次仍无法进食 → 判定接近算法极限，弹出提示
    // 仅在演示模式 + 长蛇状态触发，避免初期误判
    if (demoMode && stuckSteps >= 3 * snake.length &&
        snake.length >= Math.floor(COLS * ROWS / 2)) {
      return gameNearMax();
    }
  }

  draw();
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (gameState !== 'running') return;
    elapsedSeconds++;
    const m = Math.floor(elapsedSeconds / 60);
    const s = elapsedSeconds % 60;
    timerDisplayEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (demoMode && elapsedSeconds >= demoDurationSecs) {
      pauseGame();
      overlayTitle.textContent = '🎓 演示结束';
      overlayMsg.textContent = `演示完成！得分：${score}，现在轮到你了～`;
      btnStart.textContent = '▶ 自己来玩';
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function gameOver() {
  gameState = 'over';
  stopTimer();
  const m = Math.floor(elapsedSeconds / 60);
  const s = elapsedSeconds % 60;
  overlayTitle.textContent = '💀 游戏结束';
  overlayMsg.textContent = `得分：${score}　时长：${m}:${String(s).padStart(2,'0')}　最高：${best}`;
  btnStart.textContent = '🔄 再来一局';
  // 显示回放按钮（可用当前对局的 traceLog 回放）
  if (traceLog && traceLog.length > 0) {
    btnReplay.classList.remove('hidden');
    btnReplay.textContent = '🎬 回放本局';
  }
  overlay.classList.remove('hidden');
  overlay.classList.add('over');
  draw();
}

// 满盘通关：蛇填满整个 Hamiltonian 覆盖区域，无处再放食物
function gameWin() {
  gameState = 'over';
  stopTimer();
  const m = Math.floor(elapsedSeconds / 60);
  const s = elapsedSeconds % 60;
  overlayTitle.textContent = '🏆 通关达成！';
  overlayMsg.textContent = `完美满盘！得分：${score}　时长：${m}:${String(s).padStart(2,'0')}`;
  btnStart.textContent = '🎊 再来一局';
  if (traceLog && traceLog.length > 0) {
    btnReplay.classList.remove('hidden');
    btnReplay.textContent = '🎬 回放本局';
  }
  overlay.classList.remove('hidden');
  overlay.classList.remove('over', 'paused');
  overlay.classList.add('win');
  draw();
  // 触发烟花般的奖杯动画
  spawnTrophyConfetti();
}

// 接近算法极限：demo 模式下蛇长过半但连续 3 圈无法安全进食，判定极限
function gameNearMax() {
  gameState = 'over';
  stopTimer();
  const m = Math.floor(elapsedSeconds / 60);
  const s = elapsedSeconds % 60;
  const total = COLS * ROWS;
  const coverage = ((snake.length / total) * 100).toFixed(1);
  overlayTitle.textContent = '🏁 接近算法极限';
  overlayMsg.textContent = `得分：${score}（覆盖 ${coverage}%）　时长：${m}:${String(s).padStart(2,'0')}　剩余食物无法安全吃到`;
  btnStart.textContent = '🔄 再来一局';
  if (traceLog && traceLog.length > 0) {
    btnReplay.classList.remove('hidden');
    btnReplay.textContent = '🎬 回放本局';
  }
  overlay.classList.remove('hidden');
  overlay.classList.remove('over', 'paused', 'win');
  overlay.classList.add('near-max');
  draw();
}

// 简易撒花特效：canvas 上绘制多个奖杯 emoji 从画面各处飞过
function spawnTrophyConfetti() {
  const layer = document.getElementById('confetti-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const emojis = ['🏆', '🎉', '⭐', '✨', '🎊'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('span');
    el.className = 'confetti';
    el.textContent = emojis[i % emojis.length];
    el.style.left = Math.random() * 100 + '%';
    el.style.animationDelay = (Math.random() * 0.8) + 's';
    el.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    el.style.fontSize = (18 + Math.random() * 26) + 'px';
    layer.appendChild(el);
  }
  // 4 秒后清理
  setTimeout(() => { layer.innerHTML = ''; }, 5000);
}

// ==== 回放（Replay）模块 ============================================
// 通过 traceLog 或导入的 CSV 数据，逐帧重建游戏画面并回放。
// 不依赖 AI 决策，只按照 trace 里记录的头位置/食物/ate/death 推进蛇状态。

// CSV 解析 + 校验。返回 { ok: bool, entries?, err? }
function parseTraceCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { ok: false, err: '文件为空或没有数据行' };
  const header = lines[0].trim();
  const expected = 'step,x,y,dir,ate,food_x,food_y,death';
  if (header !== expected) {
    return { ok: false, err: `表头不匹配。期望：\n${expected}\n实际：\n${header}` };
  }
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    // 允许末尾 death 字段为空 → cols 可能是 8 (无 death) 或 9 (有 death)
    const cols = raw.split(',');
    if (cols.length !== 8 && cols.length !== 9) {
      return { ok: false, err: `第 ${i + 1} 行字段数=${cols.length}，期望 8 或 9` };
    }
    const [step, x, y, dirX, dirY, ate, fX, fY] = cols;
    const death = (cols[8] || '').trim();
    const nums = [step, x, y, dirX, dirY, ate, fX, fY].map(Number);
    if (nums.some(n => Number.isNaN(n))) {
      return { ok: false, err: `第 ${i + 1} 行含非数字字段` };
    }
    entries.push({
      step: nums[0],
      x: nums[1], y: nums[2],
      dir: `${nums[3]},${nums[4]}`,
      ate: nums[5] === 1,
      foodX: nums[6], foodY: nums[7],
      death: death,
    });
  }
  return { ok: true, entries };
}

// 由 trace 推算迷宫尺寸：取 max(x,y,foodX,foodY) + 1，向上匹配到 {10,15,25}
function deriveGridSize(entries) {
  let m = 0;
  for (const e of entries) {
    if (e.x > m) m = e.x;
    if (e.y > m) m = e.y;
    if (e.foodX > m) m = e.foodX;
    if (e.foodY > m) m = e.foodY;
  }
  const need = m + 1;
  for (const n of [10, 15, 25]) if (n >= need) return n;
  return 25;
}

// 用足迹数据填充右侧列表（供导入后展示）
function populateTraceListFromEntries(entries) {
  clearTrace();
  traceLog = entries.slice();
  traceStep = entries.length;
  entries.forEach(appendTraceItem);
  // 定位到列表顶部（准备从头回放）
  traceList.scrollTop = 0;
}

// 启动回放：切换到 replaying 状态，重置计分/计时/蛇状态
function startReplay(entries) {
  if (!entries || entries.length === 0) return;
  const n = deriveGridSize(entries);
  if (n !== COLS) {
    setGridSize(n);
    gridSizeSel.value = String(n);
  }
  // 若外部传入不同于当前 traceLog 的 entries，填充列表
  if (entries !== traceLog) {
    populateTraceListFromEntries(entries);
  }
  // 清除旧的当前行高亮
  const prev = traceList.querySelector('.trace-item.current');
  if (prev) prev.classList.remove('current');
  replayEntries = entries;
  replayIndex = 0;
  // 根据首条推算初始位置（真实游戏起始蛇在网格中心，
  // 但为了保证首条 (x,y) 与首个 unshift 一致，用 dir 反推初始头）
  const e0 = entries[0];
  const [dx, dy] = e0.dir.split(',').map(Number);
  const sx = e0.x - dx;
  const sy = e0.y - dy;
  snake = [
    { x: sx,          y: sy          },
    { x: sx - dx,     y: sy - dy     },
    { x: sx - 2 * dx, y: sy - 2 * dy },
  ];
  dir = { x: dx, y: dy };
  nextDir = { x: dx, y: dy };
  food = { x: e0.foodX, y: e0.foodY };
  score = 0;
  scoreEl.textContent = 0;
  elapsedSeconds = 0;
  timerDisplayEl.textContent = '0:00';
  fps = replayFps;
  fpsDisplayEl.textContent = fps;
  best = Math.max(best, 0);
  // 关闭 overlay，进入回放
  overlay.classList.add('hidden');
  overlay.classList.remove('paused', 'over', 'win', 'near-max');
  btnReplay.classList.add('hidden');
  gameState = 'replaying';
  lastTime = performance.now();
  startTimer();
  draw();
}

// 单步推进回放（由 gameLoop 在 replaying 状态调用）
function replayStep() {
  if (!replayEntries || replayIndex >= replayEntries.length) {
    return replayFinished(null);
  }
  const e = replayEntries[replayIndex];
  const [dx, dy] = e.dir.split(',').map(Number);
  dir = { x: dx, y: dy };
  nextDir = dir;
  if (e.death) {
    // 死亡帧：把头显示在致命位置（但不真的碰撞崩溃），随后结束
    snake.unshift({ x: e.x, y: e.y });
    // 保留死亡时的完整蛇身，不 pop
    snakeXEl.textContent = e.x;
    snakeYEl.textContent = e.y;
    draw();
    highlightTraceRow(replayIndex);
    replayIndex++;
    return replayFinished(e.death);
  }
  // 正常步：推进蛇
  snake.unshift({ x: e.x, y: e.y });
  if (e.ate) {
    score++;
    scoreEl.textContent = score;
    if (score > best) { best = score; bestEl.textContent = best; }
  } else {
    snake.pop();
  }
  // 更新食物到本条 entry 记录的位置
  food = { x: e.foodX, y: e.foodY };
  snakeXEl.textContent = e.x;
  snakeYEl.textContent = e.y;
  foodXEl.textContent = food.x;
  foodYEl.textContent = food.y;
  highlightTraceRow(replayIndex);
  replayIndex++;
  draw();
}

// 在足迹列表中高亮当前回放行，并自动滚动使其可见
function highlightTraceRow(idx) {
  // 清除旧高亮
  const prev = traceList.querySelector('.trace-item.current');
  if (prev) prev.classList.remove('current');
  const row = traceList.children[idx];
  if (!row) return;
  row.classList.add('current');
  // 计算相对滚动区域的位置，若不在可视范围则平滑滚动
  const listRect = traceList.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
    // scrollIntoView 与父元素滚动可能冲突，改用手动 scrollTop
    const offset = row.offsetTop - traceList.clientHeight / 2 + row.clientHeight / 2;
    traceList.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  }
}

function replayFinished(deathType) {
  gameState = 'over';
  stopTimer();
  const m = Math.floor(elapsedSeconds / 60);
  const s = elapsedSeconds % 60;
  let title, msg;
  if (deathType === 'wall') {
    title = '💀 回放结束 · 撞墙';
    msg = `回放得分：${score}　时长：${m}:${String(s).padStart(2, '0')}`;
  } else if (deathType === 'self') {
    title = '💀 回放结束 · 撞身';
    msg = `回放得分：${score}　时长：${m}:${String(s).padStart(2, '0')}`;
  } else {
    title = '📽 回放完成';
    msg = `完整回放结束　得分：${score}　时长：${m}:${String(s).padStart(2, '0')}`;
  }
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  btnStart.textContent = '🔄 再来一局';
  btnReplay.classList.remove('hidden');
  btnReplay.textContent = '🎬 再次回放';
  overlay.classList.remove('hidden');
  overlay.classList.remove('paused', 'win', 'near-max');
  overlay.classList.add('over');
}

// ==== Replay 模块 结束 =============================================

// ---- 绘制 ----
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawFood();
  drawSnake();
  snakeXEl.textContent = snake[0].x;
  snakeYEl.textContent = snake[0].y;
  foodXEl.textContent  = food.x;
  foodYEl.textContent  = food.y;
}

function drawGrid() {
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= canvas.width; x += CELL) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += CELL) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSnake() {
  const lastIdx = snake.length - 1;
  const tailStart = Math.max(1, snake.length - 3); // 最后 3 节视为蛇尾（渐变淡）
  // 按 CELL 缩放绘制尺寸（默认 CELL=20 时保持原视觉）
  const pad = Math.max(1, CELL * 0.1);
  const rHead = Math.max(3, CELL * 0.35);
  const rBody = Math.max(2, CELL * 0.25);

  for (let i = lastIdx; i >= 0; i--) {
    const s = snake[i];
    const px = s.x * CELL, py = s.y * CELL;
    const isHead = i === 0;
    const isTail = i >= tailStart && !isHead;

    let fillC, strokeC;
    if (isHead) {
      const atMax = fps >= FPS_CAP;
      fillC = atMax ? COLORS.snakeHeadMax : COLORS.snakeHead;
      strokeC = atMax ? COLORS.snakeHeadMaxStroke : COLORS.snakeHeadStroke;
    } else if (isTail) {
      // 越靠近末端越淡
      const tailDepth = (i - tailStart) / (lastIdx - tailStart + 1);
      // 简单在 body 和 tail 颜色间插值：这里直接用 tail 颜色，最末一节最淡
      fillC = i === lastIdx ? COLORS.snakeTail : mixColor(COLORS.snakeBody, COLORS.snakeTail, tailDepth);
      strokeC = COLORS.snakeTailStroke;
    } else {
      fillC = COLORS.snakeBody;
      strokeC = COLORS.snakeBodyStroke;
    }

    ctx.fillStyle = fillC;
    ctx.strokeStyle = strokeC;
    ctx.lineWidth = 1.5;
    roundRect(px + pad, py + pad, CELL - pad * 2, CELL - pad * 2, isHead ? rHead : rBody);
    ctx.fill();
    ctx.stroke();

    const grad = ctx.createLinearGradient(px + pad, py + pad, px + pad, py + CELL - pad);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    roundRect(px + pad, py + pad, CELL - pad * 2, CELL - pad * 2, isHead ? rHead : rBody);
    ctx.fill();

    // 除蛇头外的每一节都叠加"蛇鳞方向"字符：指示该节的移动方向
    // 方向 = snake[i-1] - snake[i]（下一帧该节将移动到前一节的位置）
    if (!isHead && i > 0) {
      const prev = snake[i - 1];
      const dx = prev.x - s.x;
      const dy = prev.y - s.y;
      let ch = '';
      if      (dx ===  1 && dy === 0) ch = '>';
      else if (dx === -1 && dy === 0) ch = '<';
      else if (dx === 0 && dy === -1) ch = '^';
      else if (dx === 0 && dy ===  1) ch = '∨';
      if (ch) {
        // 浅色（低透明度）以免视觉过重
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = `bold ${Math.max(9, CELL * 0.55)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, px + CELL / 2, py + CELL / 2);
      }
    }

    if (isHead) drawEyes(px, py);
  }
}

// 简单线性插值两个 #rrggbb 颜色，t=0 返回 c1，t=1 返回 c2
function mixColor(c1, c2, t) {
  const p = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = p(c1), [r2,g2,b2] = p(c2);
  const mix = (a,b) => Math.round(a + (b-a) * t);
  const h = (n) => n.toString(16).padStart(2,'0');
  return `#${h(mix(r1,r2))}${h(mix(g1,g2))}${h(mix(b1,b2))}`;
}

function drawEyes(px, py) {
  const cx = px + CELL / 2, cy = py + CELL / 2;
  // 按 CELL 缩放眼距和眼半径（CELL=20 时保持原视觉）
  const sc = CELL / 20;
  const off1 = 4 * sc, off2 = 3 * sc;
  const fwd = 4 * sc;
  const eyeR = 3 * sc;
  const pupR = 1.5 * sc;
  const eyeOffsets = [
    { ex: cx + dir.y * off1 - dir.x * off2, ey: cy + dir.x * off1 - dir.y * off2 },
    { ex: cx - dir.y * off1 - dir.x * off2, ey: cy - dir.x * off1 - dir.y * off2 },
  ];
  eyeOffsets.forEach(({ ex, ey }) => {
    const fx = ex + dir.x * fwd, fy = ey + dir.y * fwd;
    ctx.fillStyle = COLORS.snakeEye;
    ctx.beginPath(); ctx.arc(fx, fy, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.snakePupil;
    ctx.beginPath(); ctx.arc(fx + dir.x * sc, fy + dir.y * sc, pupR, 0, Math.PI * 2); ctx.fill();
  });
}

function drawFood() {
  if (food.x < 0 || food.y < 0) return; // 满盘胜利后无食物
  const px = food.x * CELL + CELL / 2;
  const py = food.y * CELL + CELL / 2;
  const r = CELL / 2 - 3;

  ctx.fillStyle = COLORS.food;
  ctx.strokeStyle = COLORS.foodStroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(px, py + 1, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = COLORS.foodShine;
  ctx.beginPath(); ctx.ellipse(px - 2, py - 2, r * 0.45, r * 0.3, -0.5, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = COLORS.foodLeaf;
  ctx.strokeStyle = '#27ae60';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py - r);
  ctx.quadraticCurveTo(px + 6, py - r - 6, px + 3, py - r - 2);
  ctx.quadraticCurveTo(px + 2, py - r - 7, px, py - r);
  ctx.fill(); ctx.stroke();
}

// ---- 控制 ----
document.addEventListener('keydown', e => {
  const map = {
    ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
  };
  if (map[e.key]) {
    const nd = map[e.key];
    if (nd.x !== -dir.x || nd.y !== -dir.y) nextDir = nd;
    e.preventDefault();
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (gameState === 'running' || gameState === 'replaying') pauseGame();
    else if (gameState === 'paused' || gameState === 'replay-paused') resumeGame();
  }
});

function pauseGame() {
  // 支持普通对局和回放两种暂停
  gameState = (gameState === 'replaying') ? 'replay-paused' : 'paused';
  stopTimer();
  overlayTitle.textContent = '⏸ 已暂停';
  overlayMsg.textContent = '按空格键或点击继续';
  btnStart.textContent = '▶ 继续';
  btnReplay.classList.add('hidden');
  overlay.classList.remove('hidden');
  overlay.classList.add('paused');
}

function resumeGame() {
  // 恢复到暂停之前的状态（回放 or 普通）
  gameState = (gameState === 'replay-paused') ? 'replaying' : 'running';
  overlay.classList.add('hidden');
  overlay.classList.remove('paused', 'over', 'win', 'near-max');
  lastTime = performance.now();
  startTimer();
}

// ---- 按钮 ----
btnStart.addEventListener('click', () => {
  if (gameState === 'paused' || gameState === 'replay-paused') {
    if (!toggleDemo.checked) demoMode = false;
    resumeGame();
    return;
  }
  initGame();
  gameState = 'running';
  overlay.classList.add('hidden');
  overlay.classList.remove('paused', 'over', 'win', 'near-max');
  btnReplay.classList.add('hidden');
  lastTime = performance.now();
  fpsDisplayEl.textContent = fps;
  startTimer();
  draw();
});

// 回放按钮：使用当前 traceLog 重放
btnReplay.addEventListener('click', () => {
  if (!traceLog || traceLog.length === 0) {
    alert('当前没有可回放的足迹数据');
    return;
  }
  startReplay(traceLog);
});

btnOpenSettings.addEventListener('click', () => {
  settingsPanel.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

btnApplyRestart.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  stopTimer();
  // 应用格子数变更（切换尺寸时会重建 Hamiltonian 循环）
  const newSize = parseInt(gridSizeSel.value, 10);
  if (newSize !== COLS) setGridSize(newSize);
  initGame();
  gameState = 'running';
  overlay.classList.add('hidden');
  overlay.classList.remove('paused', 'over', 'win', 'near-max');
  btnReplay.classList.add('hidden');
  lastTime = performance.now();
  fpsDisplayEl.textContent = fps;
  startTimer();
  draw();
});

// 导入 CSV 足迹并回放
btnImportReplay.addEventListener('click', () => {
  importFileInput.click();
});

importFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = ev.target.result;
    const res = parseTraceCSV(text);
    if (!res.ok) {
      alert('导入失败：\n' + res.err);
      importFileInput.value = ''; // 允许再次选择同一文件
      return;
    }
    settingsPanel.classList.add('hidden');
    populateTraceListFromEntries(res.entries);
    // 提示后开始回放（简单 alert，即点即回放）
    alert(`导入成功！共 ${res.entries.length} 条足迹。即将开始回放…`);
    startReplay(res.entries);
    importFileInput.value = '';
  };
  reader.onerror = () => {
    alert('读取文件失败');
    importFileInput.value = '';
  };
  reader.readAsText(file);
});

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    baseFps = parseInt(btn.dataset.fps, 10);
    fps = baseFps;
  });
});

toggleAutoSpeed.addEventListener('change', () => {
  autoSpeed = toggleAutoSpeed.checked;
});

toggleDemo.addEventListener('change', () => {
  demoMode = toggleDemo.checked;
});

demoDurationSel.addEventListener('change', () => {
  demoDurationSecs = parseInt(demoDurationSel.value, 10);
});

// ---- 启动 ----
initGame();
draw();
animId = requestAnimationFrame(gameLoop);
