// VOID9 3D 배선 시뮬레이터 V2
// 학습용 시각화 도구입니다. 실제 회로를 측정하거나 진단하지 않습니다.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';

/* ------------------------------------------------------------------ *
 * 1. 기준 데이터 — VOID9 QMK 백업(keyboard.json)
 * ------------------------------------------------------------------ */
const QMK = {
  development_board: 'promicro',
  bootloader: 'caterina',
  diode_direction: 'COL2ROW',
  matrix_pins: { rows: ['F4', 'F5', 'F6'], cols: ['D3', 'D4', 'D2'] },
};
// 이전 일부 가이드의 열 핀 표기(불일치 비교용)
const LEGACY_COLS = ['D1', 'D4', 'D0'];

// Pro Micro 핀(USB 쪽부터). [보드 인쇄, QMK 핀]
const PM_FRONT = [['TX0', 'D3'], ['RX1', 'D2'], ['GND', null], ['GND', null], ['2', 'D1'], ['3', 'D0'],
  ['4', 'D4'], ['5', 'C6'], ['6', 'D7'], ['7', 'E6'], ['8', 'B4'], ['9', 'B5']];
const PM_BACK = [['RAW', null], ['GND', null], ['RST', null], ['VCC', null], ['A3', 'F4'], ['A2', 'F5'],
  ['A1', 'F6'], ['A0', 'F7'], ['15', 'B1'], ['14', 'B3'], ['16', 'B2'], ['10', 'B6']];

const ROW_HEX = ['#ff6b4a', '#ffa62b', '#ffe066'];
const COL_HEX = ['#3fd0ff', '#5b7cff', '#b47bff'];
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const silkOf = (qmk) => {
  for (const [s, q] of [...PM_FRONT, ...PM_BACK]) if (q === qmk) return s;
  return '?';
};
const swNo = (r, c) => r * 3 + c + 1;

/* ------------------------------------------------------------------ *
 * 2. 형상 상수 (단위: mm, +Y = 키캡 방향, -Z = 뒤쪽/USB 쪽)
 * ------------------------------------------------------------------ */
const P = 19.05;
const keyX = (c) => (c - 1) * P;
const keyZ = (r) => (r - 1) * P;
const PM = { x: 0, y: -5.8, z: -46, len: 33, wid: 18, t: 1.6 };
const PAD_Y = PM.y - PM.t / 2;
const ROW_Y = -8.5;
const colY = (c) => -10.5 - 0.9 * c;
const rowZ = (r) => keyZ(r) + 6.5;
const diodeX = (c) => keyX(c) + 5.5;
const colX = (c) => keyX(c) - 3.81;
const PIN1 = (r, c) => new THREE.Vector3(keyX(c) - 3.81, -8.3, keyZ(r) - 2.54);
const PIN2 = (r, c) => new THREE.Vector3(keyX(c) + 2.54, -8.3, keyZ(r) - 5.08);
const CASE = { x0: -38, x1: 38, z0: -64, z1: 38, wall: 2.5, top: 3, bottomTop: -13 };

function pmPin(qmk) {
  let i = PM_FRONT.findIndex((p) => p[1] === qmk);
  if (i >= 0) return { edge: 'front', i, silk: PM_FRONT[i][0], pos: pinPos('front', i) };
  i = PM_BACK.findIndex((p) => p[1] === qmk);
  if (i >= 0) return { edge: 'back', i, silk: PM_BACK[i][0], pos: pinPos('back', i) };
  throw new Error('Unknown pin ' + qmk);
}
function pinPos(edge, i) {
  return new THREE.Vector3(PM.x + (5.5 - i) * 2.54, PAD_Y, PM.z + (edge === 'front' ? 7.62 : -7.62));
}

/* ------------------------------------------------------------------ *
 * 3. 상태
 * ------------------------------------------------------------------ */
const state = {
  step: 0,
  focus: null,          // 'row:0' | 'col:2' | null
  fault: 'none',
  selected: null,       // part
  toggles: { keycaps: true, topCase: true, bottomCase: true, labels: true },
  flash: null,          // { groups:Set, color, until }
  usbUp: true,
};

/* ------------------------------------------------------------------ *
 * 4. 단계·오류 정의
 * ------------------------------------------------------------------ */
const pinRows = QMK.matrix_pins.rows.map((q, r) => ({ sig: `R${r}`, q, silk: silkOf(q), hex: ROW_HEX[r], keys: [0, 1, 2].map((c) => `SW${swNo(r, c)}`) }));
const pinCols = QMK.matrix_pins.cols.map((q, c) => ({ sig: `C${c}`, q, silk: silkOf(q), hex: COL_HEX[c], keys: [0, 1, 2].map((r) => `SW${swNo(r, c)}`) }));

const STEPS = [
  {
    t: '부품 확인', view: 'iso', hi: [],
    body: 'VOID9는 MX 호환 기계식 스위치 9개, 1N4148 다이오드 9개, Pro Micro(ATmega32U4) 1개로 3행×3열 키 매트릭스를 구성합니다. 행 3개와 열 3개, 모두 6개의 신호선으로 9개 키의 위치를 구분합니다.',
    list: ['기계식 스위치 ×9 — SW1~SW9 (윗면 기준 왼쪽 위부터 행 순서)', '1N4148 다이오드 ×9 — 검은 띠 쪽이 캐소드', 'Pro Micro ×1 — ATmega32U4, Caterina 부트로더', '전선 — 행용 3개, 열용 3개 (교차부 절연 필요)', '3D 출력 케이스 — 상판(스위치 고정), 하판(밑면 덮개)'],
    check: '다이오드의 띠 위치와 Pro Micro의 핀 인쇄(TX0, RX1, A3 …)를 먼저 확인합니다.',
  },
  {
    t: '스위치 장착', view: 'bottomAngle', hi: ['switch'],
    body: '상판의 사각 구멍에 스위치 9개를 끼웁니다. 밑면으로 나온 금속 단자 2개가 이후 납땜 지점이 됩니다.',
    list: ['9개 스위치를 같은 방향으로 장착해 단자 위치를 통일합니다.', '이 모델에서는 단자 1 → 열 배선, 단자 2 → 다이오드로 연결합니다.', '밑면에서 보면 좌우가 반전되어 SW1이 오른쪽에 보입니다.'],
    check: '스위치가 상판에 끝까지 끼워져 흔들리지 않는지 확인합니다.',
  },
  {
    t: '다이오드 납땜', view: 'bottomAngle', hi: ['diode', 'joint:anode'],
    body: 'COL2ROW 설정에서는 다이오드의 애노드를 스위치 단자 2에 납땜하고, 검은 띠(캐소드)는 행 배선 쪽으로 향하게 둡니다.',
    list: ['9개 모두 검은 띠가 행 배선 쪽을 향하는지 확인합니다.', '다리는 짧게 정리해 다른 선과 닿지 않게 합니다.', '강조 표시: 단자 2 ↔ 애노드 납땜 9곳'],
    check: '띠 방향이 하나라도 반대면 그 키만 입력되지 않습니다. 오류 시뮬레이션에서 확인할 수 있습니다.',
  },
  {
    t: '행(Row) 배선', view: 'bottomAngle', hi: ['rowwire', 'joint:cathode'],
    body: '같은 행에 있는 다이오드 캐소드 3개를 하나의 가로 선으로 잇습니다. R0, R1, R2 세 줄이 만들어집니다.',
    list: pinRows.map((p) => `${p.sig}: ${p.keys.join(' · ')}`).concat(['강조 표시: 캐소드 ↔ 행 배선 납땜 9곳']),
    check: '행 선은 해당 행의 다이오드 끝에만 닿아야 합니다.',
  },
  {
    t: '열(Col) 배선', view: 'bottomAngle', hi: ['colwire', 'joint:col'],
    body: '같은 열에 있는 스위치 단자 1을 세로 선으로 잇습니다. 열 선은 행 선 위를 지나가므로 피복 전선을 쓰거나 높이를 띄워 절연합니다.',
    list: pinCols.map((p) => `${p.sig}: ${p.keys.join(' · ')}`).concat(['행·열이 교차하는 9곳은 서로 닿으면 안 됩니다.']),
    check: '피복이 벗겨진 곳이 교차부에 오지 않도록 배치합니다.',
  },
  {
    t: 'Pro Micro 연결', view: 'mcu', hi: ['mcuwire', 'pin:used', 'joint:mcu'],
    body: '행 3개와 열 3개의 끝을 Pro Micro 패드에 납땜합니다. 핀 배정은 VOID9 QMK 백업 값을 따릅니다.',
    list: [...pinRows, ...pinCols].map((p) => `${p.sig} → 인쇄 ${p.silk} (QMK ${p.q})`),
    check: '보드 인쇄 이름과 QMK 핀 이름은 다릅니다. "핀 설정" 탭의 대응표를 함께 보세요.',
  },
  {
    t: '전체 결선 완성', view: 'iso', hi: [],
    body: '모든 배선을 마친 상태입니다. 하판을 닫기 전에 단락, 냉납, 다이오드 방향을 다시 점검합니다.',
    list: ['멀티미터 도통 모드로 행과 열이 직접 연결되지 않았는지 확인합니다.', '납땜 부위가 매끄럽고 단단한지 확인합니다.', 'GND 연결이 흔들리지 않는지 확인합니다. VOID9에서는 GND 납땜 이탈로 USB 연결이 불안정했던 경험이 있습니다.'],
    check: '"하판 정면" 시점으로 전체 배선을 한 번에 점검할 수 있습니다.',
  },
  {
    t: '펌웨어 핀 비교', view: 'mcu', hi: ['pin:used', 'mcuwire'],
    body: 'keyboard.json의 matrix_pins 값과 실제로 납땜한 패드가 일치해야 키가 입력됩니다.',
    list: [`rows: ${QMK.matrix_pins.rows.join(', ')}  →  인쇄 ${QMK.matrix_pins.rows.map(silkOf).join(', ')}`, `cols: ${QMK.matrix_pins.cols.join(', ')}  →  인쇄 ${QMK.matrix_pins.cols.map(silkOf).join(', ')}`, `diode_direction: ${QMK.diode_direction}`],
    check: `일부 이전 가이드의 열 핀 ${LEGACY_COLS.join('/')}(인쇄 ${LEGACY_COLS.map(silkOf).join('/')})는 백업 값과 다릅니다. V2는 백업 값 ${QMK.matrix_pins.cols.join('/')}을 사용합니다.`,
  },
];

const FAULTS = {
  none: { t: '정상 배선', d: '오류 없이 완성된 상태' },
  diode: {
    t: '다이오드 방향 반대', d: 'SW5 다이오드의 띠가 스위치 쪽을 향함',
    where: 'SW5(R1·C1) 아래 다이오드 D5. 검은 띠(캐소드)가 행 배선이 아니라 스위치 단자 쪽에 있습니다.',
    symptom: 'SW5만 입력되지 않습니다. 같은 행과 열의 다른 키는 정상입니다.',
    cause: 'COL2ROW 회로에서는 열 → 스위치 → 다이오드 → 행 방향으로 전류가 흘러야 합니다. 다이오드가 뒤집히면 이 방향의 전류가 막혀, QMK가 R1을 LOW로 구동해도 C1 입력이 변하지 않습니다.',
    fix: '다이오드를 떼어 내고 검은 띠가 R1 행 배선 쪽을 향하도록 다시 납땜합니다. 나머지 8개도 같은 규칙인지 함께 확인합니다.',
    groups: ['key:1:1', 'row:1'], at: () => new THREE.Vector3(diodeX(1), -7.6, keyZ(1)),
  },
  rowBreak: {
    t: '행 배선 단선', d: 'R1 선이 SW4와 SW5 사이에서 끊김',
    where: 'R1 행 배선, SW4 다이오드와 SW5 다이오드 사이 구간',
    symptom: 'SW4(R1·C0)가 입력되지 않습니다. 이 모델은 R1 선이 오른쪽 끝에서 Pro Micro로 이어지므로, 끊긴 지점보다 보드에서 먼 쪽 키가 영향을 받습니다.',
    cause: '선이 끊기면 SW4 다이오드의 캐소드가 F5(인쇄 A2) 핀과 분리됩니다. 키를 눌러도 LOW 신호가 열 입력까지 전달되지 않습니다.',
    fix: '끊긴 구간을 새 전선으로 잇고 다시 납땜합니다. 멀티미터 도통 모드로 SW4 다이오드 캐소드와 A2 패드 사이가 연결되는지 확인합니다.',
    groups: ['row:1'], at: () => segMid(rowSegPts(1, '01')),
  },
  colBreak: {
    t: '열 배선 단선', d: 'C1 선이 SW2와 SW5 사이에서 끊김',
    where: 'C1 열 배선, SW2와 SW5 사이(R0–R1 구간)',
    symptom: 'SW5(R1·C1)와 SW8(R2·C1)이 입력되지 않습니다. SW2는 정상입니다.',
    cause: '이 모델은 C1 선이 뒤쪽(보드 쪽)에서 D4(인쇄 4)로 이어집니다. 끊긴 지점 아래의 스위치 단자는 D4 입력과 분리됩니다.',
    fix: '끊긴 구간을 다시 잇고, SW8 단자 1과 Pro Micro 4번 패드 사이 도통을 확인합니다.',
    groups: ['col:1'], at: () => segMid(colSegPts(1, '01')),
  },
  wrongPin: {
    t: '잘못된 MCU 핀 연결', d: 'C0 선을 인쇄 "2"(D1)에 연결',
    where: `C0 열 배선 끝. 선이 인쇄 "2"(QMK D1) 패드에 연결되어 있지만, 펌웨어는 인쇄 "${silkOf(QMK.matrix_pins.cols[0])}"(QMK ${QMK.matrix_pins.cols[0]})를 읽습니다.`,
    symptom: 'C0 열의 SW1, SW4, SW7이 모두 입력되지 않습니다. 배선은 멀쩡해 보여 원인을 찾기 어렵습니다.',
    cause: `QMK는 matrix_pins.cols의 첫 값 ${QMK.matrix_pins.cols[0]}을 C0으로 읽습니다. 선이 D1에 연결되면 펌웨어가 읽는 핀에는 신호가 들어오지 않습니다. 보드 인쇄 이름과 QMK 핀 이름을 혼동했거나, 이전 가이드의 ${LEGACY_COLS.join('/')} 표기를 따랐을 때 생길 수 있는 오류입니다.`,
    fix: `선을 인쇄 "${silkOf(QMK.matrix_pins.cols[0])}" 패드로 옮기거나, 실물 배선이 의도한 것이라면 keyboard.json의 열 핀을 실제 연결에 맞게 고칩니다. 어느 쪽을 바꾸든 먼저 실물 패드를 사진과 멀티미터로 확인합니다.`,
    groups: ['col:0', 'pad:D1'], at: () => pmPin('D1').pos.clone(),
  },
  short: {
    t: '불필요한 전선 접촉', d: 'R0와 C1이 교차부에서 닿음',
    where: 'R0 행 배선과 C1 열 배선이 교차하는 지점. 피복이 벗겨져 두 선이 직접 닿아 있습니다.',
    symptom: 'SW2(R0·C1)가 계속 눌린 것처럼 인식되어 같은 입력이 반복될 수 있습니다. 다른 키와 함께 누르면 의도하지 않은 키가 입력될 수 있습니다.',
    cause: '행과 열이 스위치·다이오드를 거치지 않고 직접 연결되면, QMK가 R0을 LOW로 구동할 때마다 C1이 LOW로 읽힙니다. 펌웨어는 이것을 SW2 입력으로 해석합니다.',
    fix: '닿은 부분을 떼어 내고 열 배선에 피복이나 수축 튜브를 씌워 절연합니다. 도통 모드로 R0와 C1 사이가 끊겨 있는지 확인합니다.',
    groups: ['row:0', 'col:1'], at: () => new THREE.Vector3(colX(1), (ROW_Y + colY(1)) / 2, rowZ(0)),
  },
  coldJoint: {
    t: '납땜 접촉 불량', d: 'SW7 열 단자의 냉납',
    where: 'SW7(R2·C0) 단자 1과 C0 열 배선의 납땜 부위',
    symptom: 'SW7이 가끔만 입력되거나, 케이스를 누르거나 기울일 때 입력이 끊깁니다.',
    cause: '납이 단자와 전선을 충분히 감싸지 못한 냉납은 접촉이 불안정합니다. 진동이나 힘에 따라 연결이 붙었다 떨어졌다 합니다.',
    fix: '인두로 부위를 다시 가열하고 플럭스와 적은 양의 납을 보충해, 단자와 전선을 매끄럽게 덮도록 재납땜합니다.',
    groups: ['key:2:0', 'col:0'], at: () => PIN1(2, 0),
  },
  gnd: {
    t: 'GND 접지 연결선 이탈', d: 'GND 납땜이 떨어져 USB가 불안정', real: true,
    where: 'Pro Micro GND 연결선의 납땜 부위 (이 모델에서 GND 선의 경로와 연결 대상은 단순화해 표시)',
    symptom: 'USB 연결이 끊겼다가 다시 연결되는 현상이 반복되고, 끊긴 동안에는 모든 키가 입력되지 않습니다.',
    cause: 'GND 연결선의 납땜이 떨어져 접지 연결이 불안정해졌습니다. VOID9 제작 중 실제로 겪은 문제이며, 처음에는 펌웨어나 핀 설정 문제로 오해하기 쉽습니다.',
    fix: 'GND 납땜 부위를 다시 납땜해 고정합니다. VOID9에서는 재납땜 후 USB 연결과 키 입력이 정상으로 돌아왔습니다. 물리적 접촉 불량과 펌웨어 설정 오류를 구분해 점검합니다.',
    groups: ['gnd'], at: () => pinPos('back', 1),
  },
};

/* ------------------------------------------------------------------ *
 * 5. 3D 장면
 * ------------------------------------------------------------------ */
const viewport = document.getElementById('viewport');
let renderer, labelRenderer, scene, camera, controls;
const parts = [];           // { obj, mats[], kind, step, groups:Set, info, color }
const labels = [];          // { obj, el, kind, groups }
const faultObjs = {};       // fault id -> { show:[], hide:[] }
let faultMarker, faultLabel;

function initThree() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('webglFail').hidden = false;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0f151e, 1);
  viewport.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');

  labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.setAttribute('aria-hidden', 'true');
  viewport.appendChild(labelRenderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 2000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !REDUCED;
  controls.dampingFactor = 0.09;
  controls.minDistance = 25;
  controls.maxDistance = 420;
  controls.screenSpacePanning = true;

  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x1a1f28, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(60, 140, 90); scene.add(key);
  const under = new THREE.DirectionalLight(0xcfe0ff, 1.25); under.position.set(-50, -150, -40); scene.add(under);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5); rim.position.set(-80, 20, -120); scene.add(rim);
  return true;
}

function mat(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.55, metalness: o.metal ?? 0.05, transparent: o.opacity !== undefined, opacity: o.opacity ?? 1, depthWrite: o.opacity === undefined || o.opacity > 0.6, side: o.side ?? THREE.FrontSide });
}

function addPart(obj, def) {
  const mats = [];
  obj.traverse((m) => {
    if (m.isMesh) {
      m.material = m.material.clone();
      m.material.userData.baseOpacity = m.material.opacity;
      m.material.userData.baseTransparent = m.material.transparent;
      m.material.userData.baseColor = m.material.color.clone();
      mats.push(m.material);
      m.userData.part = null;
    }
  });
  const part = { obj, mats, kind: def.kind, step: def.step ?? 0, groups: new Set(def.groups || []), info: def.info, name: def.name, alt: def.alt || null, fit: def.fit || null };
  obj.traverse((m) => { if (m.isMesh) m.userData.part = part; });
  scene.add(obj);
  parts.push(part);
  return part;
}

function addLabel(text, pos, cls, groups = [], kind = 'misc') {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls;
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  scene.add(o);
  const l = { obj: o, el, kind, groups: new Set(groups) };
  labels.push(l);
  return l;
}

function tube(points, radius, color, o = {}) {
  const path = new THREE.CurvePath();
  for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  const g = new THREE.Group();
  const geo = new THREE.TubeGeometry(path, Math.max(8, (points.length - 1) * 24), radius, 10, false);
  g.add(new THREE.Mesh(geo, mat(color, o)));
  for (let i = 1; i < points.length - 1; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), mat(color, o));
    s.position.copy(points[i]); g.add(s);
  }
  return g;
}

function sphere(pos, r, color, o) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(color, o));
  m.position.copy(pos);
  return m;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const segMid = (pts) => pts[0].clone().lerp(pts[pts.length - 1], 0.5);

function rowSegPts(r, seg) {
  const z = rowZ(r);
  if (seg === '01') return [V(diodeX(0), ROW_Y, z), V(diodeX(1), ROW_Y, z)];
  if (seg === '12') return [V(diodeX(1), ROW_Y, z), V(diodeX(2), ROW_Y, z)];
  if (seg === 'tail') return [V(diodeX(0) - 3, ROW_Y, z), V(diodeX(0), ROW_Y, z)];
  // mcu
  const pin = pmPin(QMK.matrix_pins.rows[r]).pos;
  const lx = 31.5 + 1.5 * r, lz = -56.5 - 1.5 * r;
  return [V(diodeX(2), ROW_Y, z), V(lx, ROW_Y, z), V(lx, ROW_Y, lz), V(pin.x, ROW_Y, lz), V(pin.x, ROW_Y, pin.z - 1.5), pin.clone()];
}
function colSegPts(c, seg, pinName) {
  const x = colX(c), y = colY(c);
  if (seg === '12') return [V(x, y, keyZ(2) - 2.54 + 3), V(x, y, keyZ(1) - 2.54)];
  if (seg === '01') return [V(x, y, keyZ(1) - 2.54), V(x, y, keyZ(0) - 2.54)];
  const pin = pmPin(pinName || QMK.matrix_pins.cols[c]).pos;
  const lz = [-30.5, -33, -32][c];
  return [V(x, y, keyZ(0) - 2.54), V(x, y, lz), V(pin.x, y, lz), V(pin.x, y, pin.z + 1.5), pin.clone()];
}

function brokenPair(pts, color, radius, o) {
  const a = pts[0], b = pts[pts.length - 1];
  const g = new THREE.Group();
  g.add(tube([a.clone(), a.clone().lerp(b, 0.4)], radius, color, o));
  g.add(tube([b.clone().lerp(a, 0.4), b.clone()], radius, color, o));
  return g;
}

function buildCase() {
  // 상판: 스위치 구멍이 있는 판 + 둘레 벽
  const outer = new THREE.Shape();
  outer.moveTo(CASE.x0, CASE.z0); outer.lineTo(CASE.x1, CASE.z0); outer.lineTo(CASE.x1, CASE.z1); outer.lineTo(CASE.x0, CASE.z1); outer.lineTo(CASE.x0, CASE.z0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const h = new THREE.Path(); const x = keyX(c), z = keyZ(r), s = 7;
    h.moveTo(x - s, z - s); h.lineTo(x - s, z + s); h.lineTo(x + s, z + s); h.lineTo(x + s, z - s); h.lineTo(x - s, z - s);
    outer.holes.push(h);
  }
  const plateGeo = new THREE.ExtrudeGeometry(outer, { depth: 1.5, bevelEnabled: false });
  plateGeo.rotateX(Math.PI / 2);
  const caseColor = 0x2152d9;
  const top = new THREE.Group();
  top.add(new THREE.Mesh(plateGeo, mat(caseColor, { rough: 0.7 })));
  const frame = new THREE.Shape();
  frame.moveTo(CASE.x0, CASE.z0); frame.lineTo(CASE.x1, CASE.z0); frame.lineTo(CASE.x1, CASE.z1); frame.lineTo(CASE.x0, CASE.z1); frame.lineTo(CASE.x0, CASE.z0);
  const w = CASE.wall, inner = new THREE.Path();
  inner.moveTo(CASE.x0 + w, CASE.z0 + w); inner.lineTo(CASE.x0 + w, CASE.z1 - w); inner.lineTo(CASE.x1 - w, CASE.z1 - w); inner.lineTo(CASE.x1 - w, CASE.z0 + w); inner.lineTo(CASE.x0 + w, CASE.z0 + w);
  frame.holes.push(inner);
  const wallGeo = new THREE.ExtrudeGeometry(frame, { depth: CASE.top - CASE.bottomTop, bevelEnabled: false });
  wallGeo.rotateX(Math.PI / 2); wallGeo.translate(0, CASE.top, 0);
  top.add(new THREE.Mesh(wallGeo, mat(caseColor, { rough: 0.7 })));
  addPart(top, {
    kind: 'case', name: '케이스 상판', step: 0, groups: ['case', 'topCase'], fit: V(0, 0, -12),
    info: () => ({ title: '케이스 상판', sub: '3D 출력 · 스위치 고정판', rows: [['역할', '스위치 9개를 고정하고 배선 공간의 옆면을 둘러쌉니다.'], ['정확성', '형상과 치수는 시각화 모델입니다. 실물은 사진을 참고하세요.']] }),
  });

  const bot = new THREE.Group();
  const bGeo = new THREE.BoxGeometry(CASE.x1 - CASE.x0, 2, CASE.z1 - CASE.z0);
  const bm = new THREE.Mesh(bGeo, mat(0x1b3f9e, { rough: 0.8 }));
  bm.position.set((CASE.x0 + CASE.x1) / 2, CASE.bottomTop - 1, (CASE.z0 + CASE.z1) / 2);
  bot.add(bm);
  for (const [x, z] of [[CASE.x0 + 5, CASE.z0 + 5], [CASE.x1 - 5, CASE.z0 + 5], [CASE.x0 + 5, CASE.z1 - 5], [CASE.x1 - 5, CASE.z1 - 5]]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.6, 20), mat(0xb8c0cc, { metal: 0.7, rough: 0.3 }));
    s.position.set(x, CASE.bottomTop - 2.2, z); bot.add(s);
  }
  addPart(bot, {
    kind: 'case', name: '케이스 하판', step: 6, groups: ['case', 'bottomCase'], fit: V(0, -14, -12),
    info: () => ({ title: '케이스 하판', sub: '밑면 덮개', rows: [['역할', '배선과 Pro Micro를 덮어 보호합니다.'], ['팁', '"하판 정면"·"하판 사선" 시점에서는 배선을 보이도록 자동으로 숨깁니다. 상단 "하판" 버튼으로 다시 켤 수 있습니다.']] }),
  });
}

function keyInfo(r, c, what) {
  const R = pinRows[r], C = pinCols[c];
  return () => ({
    title: `SW${swNo(r, c)} ${what}`, sub: `매트릭스 [${r}, ${c}] · R${r} / C${c}`,
    rows: [['행', `R${r} → 인쇄 ${R.silk} (QMK ${R.q})`], ['열', `C${c} → 인쇄 ${C.silk} (QMK ${C.q})`], ['단자 1', `C${c} 열 배선과 납땜`], ['단자 2', `다이오드 D${swNo(r, c)} 애노드와 납땜`], ['입력 원리', `QMK가 R${r}(${R.q})을 LOW로 구동하는 순간 이 키가 눌려 있으면 C${c}(${C.q})이 LOW로 읽힙니다.`]],
    test: [r, c],
  });
}

function buildSwitches() {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = keyX(c), z = keyZ(r);
    const sw = new THREE.Group();
    const clear = mat(0xdbe6ef, { opacity: 0.55, rough: 0.2 });
    const upper = new THREE.Mesh(new THREE.BoxGeometry(14.6, 5, 14.6), clear); upper.position.y = 2.5; sw.add(upper);
    const flange = new THREE.Mesh(new THREE.BoxGeometry(15.6, 1, 15.6), mat(0xe6edf3, { rough: 0.4 })); flange.position.y = 0.5; sw.add(flange);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(13.8, 3.5, 13.8), clear); lower.position.y = -3.25; sw.add(lower);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 3, 16), mat(0xe6edf3)); post.position.y = -6.5; sw.add(post);
    for (const p of [PIN1(r, c), PIN2(r, c)]) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 3.3, 10), mat(0xd4a64a, { metal: 0.8, rough: 0.3 }));
      pin.position.set(p.x - x, -6.65, p.z - z); sw.add(pin);
    }
    sw.position.set(x, 0, z);
    addPart(sw, { kind: 'switch', step: 1, groups: ['switch', `key:${r}:${c}`], info: keyInfo(r, c, '기계식 스위치'), fit: V(x, -4, z) });

    // 스템 + 키캡 (누름 애니메이션 대상)
    const cap = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.BoxGeometry(4.2, 4, 4.2), mat(0x6b3b26, { rough: 0.6 })); stem.position.y = 6.5; cap.add(stem);
    const kc = new THREE.Mesh(new THREE.CylinderGeometry(8.6, 12.7, 8, 4, 1), mat(0xeef1f4, { rough: 0.65 }));
    kc.rotation.y = Math.PI / 4; kc.position.y = 12.3; cap.add(kc);
    const dish = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 11), mat(0xdfe4ea)); dish.position.y = 16.35; cap.add(dish);
    cap.position.set(x, 0, z);
    const p = addPart(cap, { kind: 'keycap', step: 1, groups: ['keycap', 'switch', `key:${r}:${c}`], info: keyInfo(r, c, '키캡 · 스위치'), fit: V(x, 4, z) });
    p.key = [r, c];
    stem.userData.isStem = true;
    const sl = addLabel(`SW${swNo(r, c)}`, V(x, 18, z), 'sw', [`key:${r}:${c}`], 'sw');
    sl.base = V(x, 18, z); sl.under = V(x, -14.5, z);
  }
}

function buildDiode(r, c, reversed) {
  const x = diodeX(c), z = keyZ(r);
  const g = new THREE.Group();
  const p2 = PIN2(r, c);
  const lead = 0xc9ced6;
  g.add(tube([p2.clone(), V(x, -8.1, p2.z), V(x, -7.6, z - 1.8)], 0.25, lead, { metal: 0.8, rough: 0.3 }));
  g.add(tube([V(x, -7.6, z + 1.8), V(x, ROW_Y, rowZ(r) - 0.8), V(x, ROW_Y, rowZ(r))], 0.25, lead, { metal: 0.8, rough: 0.3 }));
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 3.6, 16), mat(0xe0662e, { opacity: 0.88, rough: 0.25 }));
  body.rotation.x = Math.PI / 2; body.position.set(x, -7.6, z); g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.94, 0.94, 0.7, 16), mat(0x111111, { rough: 0.5 }));
  band.rotation.x = Math.PI / 2; band.position.set(x, -7.6, z + (reversed ? -1.3 : 1.3)); g.add(band);
  return g;
}

function diodeInfo(r, c, reversed) {
  return () => ({
    title: `D${swNo(r, c)} 다이오드 (1N4148)`, sub: `SW${swNo(r, c)} · R${r}`,
    rows: [['애노드', `SW${swNo(r, c)} 단자 2`], ['캐소드(검은 띠)', `R${r} 행 배선 (${pinRows[r].q} / 인쇄 ${pinRows[r].silk})`], ['방향', `COL2ROW: 열 → 스위치 → 다이오드 → 행`], ['역할', '여러 키를 동시에 눌렀을 때 다른 경로로 전류가 돌아 들어가 엉뚱한 키가 인식되는 현상(고스팅)을 막습니다.'], ...(reversed ? [['현재 상태', '오류 시뮬레이션: 띠가 스위치 쪽으로 뒤집혀 있습니다.']] : [])],
  });
}

function buildMatrixWiring() {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const n = swNo(r, c);
    addPart(buildDiode(r, c, false), { kind: 'diode', step: 2, groups: ['diode', `key:${r}:${c}`, `row:${r}`], info: diodeInfo(r, c, false), fit: V(diodeX(c), -7.6, keyZ(r)), alt: r === 1 && c === 1 ? 'diode:normal' : null });
    // 애노드 납땜
    addPart(sphere(PIN2(r, c), 1.05, 0xd9dde3, { metal: 0.6, rough: 0.35 }), { kind: 'joint', step: 2, groups: ['joint', 'joint:anode', `key:${r}:${c}`, `row:${r}`], fit: PIN2(r, c), info: () => ({ title: `납땜 지점 · SW${n} 단자 2 ↔ D${n} 애노드`, sub: '다이오드 납땜', rows: [['확인', '납이 단자와 다이오드 다리를 매끄럽게 감싸야 합니다.']] }) });
    // 캐소드-행 납땜
    const cp = V(diodeX(c), ROW_Y, rowZ(r));
    addPart(sphere(cp, 1.05, 0xd9dde3, { metal: 0.6, rough: 0.35 }), { kind: 'joint', step: 3, groups: ['joint', 'joint:cathode', `key:${r}:${c}`, `row:${r}`], fit: cp, info: () => ({ title: `납땜 지점 · D${n} 캐소드 ↔ R${r}`, sub: '행 배선 납땜', rows: [['확인', '검은 띠 쪽 다리가 행 배선에 닿아 있어야 합니다.']] }) });
    // 열 단자 납땜 + 라이저
    const p1 = PIN1(r, c);
    const riser = tube([p1.clone(), V(p1.x, colY(c), p1.z)], 0.45, COL_HEX[c], { rough: 0.5 });
    addPart(riser, { kind: 'wire', step: 4, groups: ['colwire', `col:${c}`, `key:${r}:${c}`], info: colInfo(c), fit: p1 });
    const cj = addPart(sphere(p1, 1.05, 0xd9dde3, { metal: 0.6, rough: 0.35 }), { kind: 'joint', step: 4, groups: ['joint', 'joint:col', `key:${r}:${c}`, `col:${c}`], fit: p1, info: () => ({ title: `납땜 지점 · SW${n} 단자 1 ↔ C${c}`, sub: '열 배선 납땜', rows: [['확인', '열 선이 단자에 단단히 붙고, 주변 행 선과 닿지 않아야 합니다.']] }) });
    if (r === 2 && c === 0) cj.alt = 'cold:normal';
  }
  // 오류용 대체 형상: 뒤집힌 다이오드
  const rev = addPart(buildDiode(1, 1, true), { kind: 'diode', step: 2, groups: ['diode', 'key:1:1', 'row:1'], info: diodeInfo(1, 1, true), fit: V(diodeX(1), -7.6, keyZ(1)), alt: 'diode:fault' });
  rev.obj.visible = false;
  // 냉납
  const cold = addPart(sphere(PIN1(2, 0).add(V(0.5, -0.3, 0.4)), 0.75, 0x7d7a73, { rough: 0.95 }), { kind: 'joint', step: 4, groups: ['joint', 'key:2:0', 'col:0'], fit: PIN1(2, 0), alt: 'cold:fault', info: () => ({ title: '납땜 지점 · SW7 단자 1 (냉납)', sub: '오류 시뮬레이션', rows: [['상태', '납이 단자를 충분히 감싸지 못한 접촉 불량 상태입니다.']] }) });
  cold.obj.scale.set(1, 0.6, 1);

  // 행 배선
  for (let r = 0; r < 3; r++) {
    const o = { metal: 0.55, rough: 0.35 };
    for (const seg of ['tail', '01', '12']) {
      const p = addPart(tube(rowSegPts(r, seg), 0.42, ROW_HEX[r], o), { kind: 'wire', step: 3, groups: ['rowwire', `row:${r}`], info: rowInfo(r), fit: segMid(rowSegPts(r, '01')) });
      if (r === 1 && seg === '01') p.alt = 'rowbreak:normal';
    }
    addPart(tube(rowSegPts(r, 'mcu'), 0.42, ROW_HEX[r], o), { kind: 'wire', step: 5, groups: ['rowwire', 'mcuwire', `row:${r}`], info: rowInfo(r), fit: pmPin(QMK.matrix_pins.rows[r]).pos });
    const L = addLabel(`R${r} · ${pinRows[r].q} / ${pinRows[r].silk}`, V(diodeX(0) - 9, ROW_Y, rowZ(r)), 'row' + r, [`row:${r}`], 'line');
    L.step = 3;
  }
  const rb = addPart(brokenPair(rowSegPts(1, '01'), ROW_HEX[1], 0.42, { metal: 0.55, rough: 0.35 }), { kind: 'wire', step: 3, groups: ['rowwire', 'row:1'], info: rowInfo(1), alt: 'rowbreak:fault' });
  rb.obj.visible = false;

  // 열 배선 (피복 전선)
  for (let c = 0; c < 3; c++) {
    for (const seg of ['12', '01']) {
      const p = addPart(tube(colSegPts(c, seg), 0.7, COL_HEX[c], { rough: 0.6 }), { kind: 'wire', step: 4, groups: ['colwire', `col:${c}`], info: colInfo(c), fit: segMid(colSegPts(c, '01')) });
      if (c === 1 && seg === '01') p.alt = 'colbreak:normal';
    }
    const m = addPart(tube(colSegPts(c, 'mcu'), 0.7, COL_HEX[c], { rough: 0.6 }), { kind: 'wire', step: 5, groups: ['colwire', 'mcuwire', `col:${c}`], info: colInfo(c), fit: pmPin(QMK.matrix_pins.cols[c]).pos });
    if (c === 0) m.alt = 'wrongpin:normal';
    const L = addLabel(`C${c} · ${pinCols[c].q} / ${pinCols[c].silk}`, V(colX(c), colY(c), keyZ(2) + 8 + (c === 1 ? 4 : 0)), 'col' + c, [`col:${c}`], 'line');
    L.step = 4;
  }
  const cb = addPart(brokenPair(colSegPts(1, '01'), COL_HEX[1], 0.7, { rough: 0.6 }), { kind: 'wire', step: 4, groups: ['colwire', 'col:1'], info: colInfo(1), alt: 'colbreak:fault' });
  cb.obj.visible = false;
  const wp = addPart(tube(colSegPts(0, 'mcu', 'D1'), 0.7, COL_HEX[0], { rough: 0.6 }), { kind: 'wire', step: 5, groups: ['colwire', 'mcuwire', 'col:0'], info: colInfo(0, true), alt: 'wrongpin:fault' });
  wp.obj.visible = false;
  // 쇼트 브리지
  const sp = FAULTS.short.at();
  const bridge = addPart(tube([V(sp.x, ROW_Y, sp.z), V(sp.x, colY(1), sp.z)], 0.75, 0xff3b3b, { rough: 0.4 }), { kind: 'wire', step: 4, groups: ['row:0', 'col:1'], alt: 'short:fault', info: () => ({ title: 'R0–C1 접촉 지점', sub: '오류 시뮬레이션', rows: [['상태', '피복이 벗겨져 행과 열이 직접 닿아 있습니다.']] }) });
  bridge.obj.visible = false;
}

function rowInfo(r) {
  return () => ({
    title: `R${r} 행 배선`, sub: `QMK ${pinRows[r].q} · 보드 인쇄 ${pinRows[r].silk}`,
    rows: [['연결 키', pinRows[r].keys.join(', ')], ['연결 방식', '다이오드 캐소드(검은 띠) 3개를 한 선으로 연결'], ['펌웨어 동작', `COL2ROW에서 QMK가 이 행을 하나씩 LOW로 구동합니다.`], ['정확성', '연결 관계는 QMK 백업 기준, 선의 경로는 시각화 모델입니다.']],
    focus: `row:${r}`,
  });
}
function colInfo(c, wrong) {
  return () => ({
    title: `C${c} 열 배선`, sub: `QMK ${pinCols[c].q} · 보드 인쇄 ${pinCols[c].silk}`,
    rows: [['연결 키', pinCols[c].keys.join(', ')], ['연결 방식', '스위치 단자 1 세 개를 피복 전선으로 연결'], ['펌웨어 동작', 'QMK가 풀업 입력으로 읽습니다. 눌린 키가 있으면 LOW가 됩니다.'], ['정확성', '연결 관계는 QMK 백업 기준, 선의 경로는 시각화 모델입니다.'], ...(wrong ? [['현재 상태', '오류 시뮬레이션: 인쇄 "2"(D1)에 잘못 연결됨']] : [])],
    focus: `col:${c}`,
  });
}

function buildProMicro() {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(PM.len, PM.t, PM.wid), mat(0x1f4fb8, { rough: 0.6 }));
  pcb.position.set(PM.x, PM.y, PM.z); g.add(pcb);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(7, 1, 7), mat(0x15171b, { rough: 0.5 }));
  chip.rotation.y = Math.PI / 4; chip.position.set(PM.x - 1, PAD_Y - 0.5, PM.z); g.add(chip);
  const usb = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.6, 7.6), mat(0xc0c6cf, { metal: 0.8, rough: 0.3 }));
  usb.position.set(PM.x + PM.len / 2 - 2, PAD_Y - 1.3, PM.z); g.add(usb);
  const xtal = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.8, 2.5), mat(0xd0d4da, { metal: 0.6 }));
  xtal.position.set(PM.x + 7, PAD_Y - 0.4, PM.z + 3); g.add(xtal);
  addPart(g, {
    kind: 'mcu', step: 5, groups: ['mcu'], fit: V(PM.x, PAD_Y, PM.z),
    info: () => ({ title: 'Pro Micro (ATmega32U4)', sub: `development_board: ${QMK.development_board} · bootloader: ${QMK.bootloader}`, rows: [['역할', '행을 순서대로 구동하고 열을 읽어 눌린 키를 찾은 뒤 USB 키보드 신호로 보냅니다.'], ['사용 핀', `행 ${pinRows.map((p) => p.silk).join('/')} · 열 ${pinCols.map((p) => p.silk).join('/')}`], ['배치', '이 모델은 부품면이 하판 쪽을 향하도록 놓았습니다. 실제 위치와 방향은 실물 사진을 확인하세요.']] }),
  });

  const used = new Map();
  pinRows.forEach((p, r) => used.set(p.q, { sig: `R${r}`, group: `row:${r}`, cls: 'row' + r }));
  pinCols.forEach((p, c) => used.set(p.q, { sig: `C${c}`, group: `col:${c}`, cls: 'col' + c }));
  for (const [edge, list] of [['front', PM_FRONT], ['back', PM_BACK]]) {
    list.forEach(([silk, q], i) => {
      const pos = pinPos(edge, i);
      const u = q && used.get(q);
      const isGnd = silk === 'GND';
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.3, 16), mat(u ? 0xffd27a : 0xc9a24a, { metal: 0.85, rough: 0.25 }));
      pad.position.copy(pos).add(V(0, -0.1, 0));
      const groups = ['mcu', 'pad', 'pad:' + (q || silk)];
      if (u) groups.push('pin:used', u.group);
      if (isGnd && edge === 'back' && i === 1) groups.push('gnd');
      const part = addPart(pad, {
        kind: 'pin', step: 5, groups, fit: pos,
        info: () => ({ title: `Pro Micro 핀 · 인쇄 ${silk}`, sub: q ? `QMK 핀 ${q}` : (isGnd ? '접지' : '전원/리셋'), rows: [['VOID9 연결', u ? `${u.sig} (${u.sig.startsWith('R') ? '행' : '열'})` : (isGnd && edge === 'back' && i === 1 ? 'GND 연결선 (경로는 단순화)' : '사용하지 않음')], ...(LEGACY_COLS.includes(q) && !u ? [['주의', `이전 가이드의 열 핀 표기 ${LEGACY_COLS.join('/')}에 포함된 핀입니다. VOID9 백업에서는 사용하지 않습니다.`]] : [])] }),
      });
      if (u) addPart(sphere(pos.clone().add(V(0, -0.5, 0)), 1.0, 0xd9dde3, { metal: 0.6, rough: 0.35 }), { kind: 'joint', step: 5, groups: ['joint', 'joint:mcu', 'mcu', u.group], fit: pos, info: part.info });
      const L = addLabel(silk, pos.clone().add(V(0, -1.6, edge === 'front' ? 1.6 : -1.6)), 'pin' + (u ? ' used' : '') + (isGnd ? ' gnd' : ''), u ? [u.group, 'mcu'] : ['mcu'], u ? 'pinUsed' : 'pin');
      L.step = 5;
    });
  }

  // GND 연결선 (단순화 모델)
  const gp = pinPos('back', 1);
  const gpts = [gp.clone(), V(gp.x, -9.5, gp.z), V(gp.x, -9.5, -59), V(28, -9.5, -59), V(28, -9.5, -61.3)];
  addPart(tube(gpts, 0.7, 0x22252b, { rough: 0.6 }), { kind: 'wire', step: 5, groups: ['gnd', 'mcuwire'], alt: 'gnd:normal', fit: gp, info: gndInfo });
  addPart(sphere(gp.clone().add(V(0, -0.5, 0)), 1.0, 0xd9dde3, { metal: 0.6, rough: 0.35 }), { kind: 'joint', step: 5, groups: ['joint', 'joint:mcu', 'gnd'], fit: gp, alt: 'gnd:normal', info: gndInfo });
  const tab = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 0.6), mat(0xb8c0cc, { metal: 0.7, rough: 0.3 }));
  tab.position.set(28, -9.5, -61.4);
  addPart(tab, { kind: 'mcu', step: 5, groups: ['gnd'], fit: tab.position, info: gndInfo });
  const det = [V(gp.x + 1.5, -11.5, gp.z - 3), V(gp.x + 1.5, -9.5, -59), V(28, -9.5, -59), V(28, -9.5, -61.3)];
  const d = addPart(tube(det, 0.7, 0x22252b, { rough: 0.6 }), { kind: 'wire', step: 5, groups: ['gnd'], alt: 'gnd:fault', fit: gp, info: gndInfo });
  d.obj.visible = false;
  const gl = addLabel('GND', V(28, -12, -60), 'pin gnd', ['gnd'], 'pinUsed'); gl.step = 5;
}
function gndInfo() {
  return { title: 'GND 연결선', sub: '접지 · 단순화 모델', rows: [['역할', '보드의 접지(0V) 기준을 연결합니다.'], ['VOID9 사례', '이 선의 납땜이 떨어져 USB 연결이 끊겼다 붙었다 했고, 재납땜 후 정상화되었습니다.'], ['정확성', '실물에서 이 선이 이어지는 위치는 자료로 확인하지 못해, 경로와 끝점(케이스 뒤쪽 금속 탭)을 단순화해 표시했습니다.']] };
}

function buildFaultMarker() {
  faultMarker = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.45, 12, 40), new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.9, depthTest: false }));
  ring.rotation.x = Math.PI / 2; ring.renderOrder = 10;
  const ring2 = ring.clone(); ring2.rotation.set(0, 0, 0);
  faultMarker.add(ring, ring2);
  faultMarker.visible = false;
  scene.add(faultMarker);
  const el = document.createElement('div'); el.className = 'lbl fault'; el.textContent = '오류 위치';
  faultLabel = new CSS2DObject(el); faultLabel.visible = false; scene.add(faultLabel);
}

/* ------------------------------------------------------------------ *
 * 6. 스타일 갱신
 * ------------------------------------------------------------------ */
const ALT_ON = {
  diode: ['diode:fault'], rowBreak: ['rowbreak:fault'], colBreak: ['colbreak:fault'], wrongPin: ['wrongpin:fault'],
  short: ['short:fault'], coldJoint: ['cold:fault'], gnd: ['gnd:fault'],
};
function altVisible(alt) {
  if (!alt) return true;
  const [k, mode] = alt.split(':');
  const fk = { diode: 'diode', rowbreak: 'rowBreak', colbreak: 'colBreak', wrongpin: 'wrongPin', short: 'short', cold: 'coldJoint', gnd: 'gnd' }[k];
  const on = state.fault === fk;
  return mode === 'fault' ? on : !on;
}

function highlightSet() {
  if (state.flash && performance.now() < state.flash.until) return { set: state.flash.groups, color: state.flash.color, src: 'flash' };
  if (state.fault !== 'none') return { set: new Set(FAULTS[state.fault].groups), color: 0xff4040, src: 'fault' };
  if (state.focus) return { set: new Set([state.focus]), color: 0xffffff, src: 'focus' };
  const hi = STEPS[state.step].hi;
  if (hi.length) return { set: new Set(hi), color: 0x7cc4ff, src: 'step' };
  return null;
}
const inSet = (part, set) => { for (const g of part.groups) if (set.has(g)) return true; return false; };
const isFullView = () => state.fault !== 'none' || state.step === 0 || state.step >= 6;

let hiCache = null;
function refresh() {
  const hi = highlightSet();
  hiCache = hi;
  for (const p of parts) {
    let vis = altVisible(p.alt) && (isFullView() || p.step <= state.step);
    if (p.kind === 'keycap' && !state.toggles.keycaps) vis = false;
    if (p.groups.has('bottomCase') && (!state.toggles.bottomCase || (!isFullView() && state.step < 6))) vis = false;
    p.obj.visible = vis;
    const topFade = p.groups.has('topCase') && !state.toggles.topCase;
    const wiring = p.kind === 'wire' || p.kind === 'diode' || p.kind === 'joint' || p.kind === 'pin' || p.kind === 'mcu';
    const isSw = p.kind === 'switch' || p.kind === 'keycap';
    const lit = hi && inSet(p, hi.set) && (!isSw || hi.src === 'flash' || hi.set.has('switch'));
    const dim = hi && !lit && (wiring || p.kind === 'switch' || p.kind === 'keycap');
    const sel = state.selected === p;
    for (const m of p.mats) {
      const baseO = m.userData.baseOpacity;
      let o = baseO;
      if (topFade) o = 0.12;
      else if (dim) o = Math.min(baseO, wiring ? 0.22 : 0.3);
      m.opacity = o;
      m.transparent = o < 1 || m.userData.baseTransparent;
      m.depthWrite = o > 0.6;
      m.emissive.setHex(sel ? (p.kind === 'case' ? 0x7cc4ff : 0xffffff) : lit ? hi.color : 0x000000);
      m.emissiveIntensity = sel ? (p.kind === 'case' ? 0.12 : 0.45) : lit ? 0.5 : 0;
      m.needsUpdate = true;
    }
  }
  const showLabels = state.toggles.labels;
  for (const l of labels) {
    let vis = showLabels && (isFullView() || (l.step ?? 0) <= state.step);
    l.baseVis = vis;
    l.obj.visible = vis;
    l.el.classList.toggle('dim', !!(hi && hi.src !== 'step' && ![...l.groups].some((g) => hi.set.has(g))));
  }
  if (faultMarker) {
    const f = FAULTS[state.fault];
    faultMarker.visible = !!f.at; faultLabel.visible = !!f.at && state.toggles.labels;
    if (f.at) { const p = f.at(); faultMarker.position.copy(p); faultLabel.position.copy(p).add(V(0, -6, 0)); }
  }
}

/* ------------------------------------------------------------------ *
 * 7. 카메라
 * ------------------------------------------------------------------ */
const VIEWS = {
  iso: { t: V(0, -4, -14), p: V(95, 100, 120), hint: '' },
  top: { t: V(0, 0, -14), p: V(0, 200, 45), hint: '윗면: 키캡 쪽에서 본 모습입니다.' },
  bottom: { t: V(0, -8, -14), p: V(0, -205, -40), hint: '하판 정면: 밑면에서 본 모습이라 좌우가 반전됩니다 (SW1·C0이 오른쪽).', under: true },
  bottomAngle: { t: V(0, -8, -14), p: V(-62, -100, -88), hint: '하판 사선: 밑면을 비스듬히 본 모습입니다. 좌우가 반전되어 보입니다.', under: true },
  mcu: { t: V(1, -7, -46), p: V(-10, -82, -72), hint: 'Pro Micro 확대: 부품면(밑면 쪽)에서 본 핀 배치입니다.', under: true },
};
let tween = null;
function aspectScale() {
  const a = camera.aspect;
  return a < 1.25 ? Math.min(2.1, 1.25 / a) : 1;
}
function flyTo(target, pos, instant) {
  const p1 = pos.clone().sub(target).multiplyScalar(aspectScale()).add(target);
  if (REDUCED || instant) {
    controls.target.copy(target); camera.position.copy(p1); controls.update(); tween = null; return;
  }
  tween = { t0: performance.now(), dur: 750, fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: p1 };
}
function setView(name, instant) {
  const v = VIEWS[name];
  flyTo(v.t, v.p, instant);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  let hint = v.hint;
  if (v.under && state.toggles.bottomCase) {
    setToggle('bottomCase', false);
    hint += ' 하판은 자동으로 숨겼습니다.';
  }
  document.getElementById('viewHint').textContent = hint;
}
function flyToPoint(pt, dist = 70) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y > -0.2) dir.set(-0.45, -0.7, -0.55).normalize();
  if (state.toggles.bottomCase) setToggle('bottomCase', false);
  flyTo(pt.clone(), pt.clone().add(dir.multiplyScalar(dist)));
}

/* ------------------------------------------------------------------ *
 * 8. 가상 입력 판정 (규칙 기반)
 * ------------------------------------------------------------------ */
function evaluate(r, c) {
  const R = pinRows[r], C = pinCols[c];
  const head = `R${r}(${R.q}/${R.silk})를 LOW로 구동 → C${c}(${C.q}/${C.silk}) 읽기`;
  const f = state.fault;
  if (f === 'gnd' && !state.usbUp) return { ok: false, head, why: 'USB 연결이 끊긴 상태입니다. 펌웨어가 PC와 통신하지 못해 입력이 전달되지 않습니다.' };
  if (f === 'diode' && r === 1 && c === 1) return { ok: false, head, why: '다이오드가 역방향이라 열 → 행 전류가 막힙니다. C1이 HIGH로 남습니다.' };
  if (f === 'rowBreak' && r === 1 && c === 0) return { ok: false, head, why: 'R1 선이 끊겨 SW4 다이오드가 F5와 분리되었습니다. C0이 HIGH로 남습니다.' };
  if (f === 'colBreak' && c === 1 && r >= 1) return { ok: false, head, why: 'C1 선이 끊겨 이 스위치가 D4 입력과 분리되었습니다.' };
  if (f === 'wrongPin' && c === 0) return { ok: false, head, why: `선은 D1(인쇄 2)에 연결되어 있지만 펌웨어는 ${C.q}(인쇄 ${C.silk})를 읽습니다. 변화가 감지되지 않습니다.` };
  if (f === 'coldJoint' && r === 2 && c === 0 && Math.random() < 0.55) return { ok: false, head, why: '냉납 부위의 접촉이 순간적으로 끊겨 이번 입력은 인식되지 않았습니다. 다시 누르면 될 수도 있습니다.' };
  return { ok: true, head, why: `C${c}이 LOW로 읽혀 매트릭스 [${r}, ${c}] = SW${swNo(r, c)} 입력으로 인식됩니다.` };
}

function pressKey(r, c, from3D) {
  const res = evaluate(r, c);
  const log = document.getElementById('scanLog');
  const extra = state.fault === 'short' ? '\n참고: R0–C1 접촉 때문에 SW2는 누르지 않아도 계속 입력 중으로 인식됩니다.' : '';
  const usb = state.fault === 'gnd' ? `\nUSB 상태: ${state.usbUp ? '연결됨' : '끊김 (재연결 대기)'}` : '';
  log.textContent = `[SW${swNo(r, c)}] ${res.head}\n결과: ${res.ok ? '입력 인식' : '입력 없음'}\n${res.why}${extra}${usb}\n(규칙 기반 가상 판정이며 실제 측정값이 아닙니다.)`;
  const btn = document.querySelector(`.vkey[data-r="${r}"][data-c="${c}"]`);
  if (btn) {
    btn.classList.remove('hit', 'miss');
    void btn.offsetWidth;
    btn.classList.add(res.ok ? 'hit' : 'miss', 'down');
    setTimeout(() => btn.classList.remove('down'), 140);
    setTimeout(() => btn.classList.remove('hit', 'miss'), 1200);
  }
  animateKey(r, c);
  state.flash = { groups: new Set([`key:${r}:${c}`, `row:${r}`, `col:${c}`]), color: res.ok ? 0x5fd38d : 0xff4040, until: performance.now() + 1100 };
  refresh();
  setTimeout(() => { if (state.flash && performance.now() >= state.flash.until) { state.flash = null; refresh(); } }, 1150);
  if (from3D) {
    document.getElementById('selectedLine').textContent = `SW${swNo(r, c)} 누름 → ${res.ok ? '입력 인식' : '입력 없음'} (가상 판정)`;
  }
}

const pressAnims = [];
function animateKey(r, c) {
  const p = parts.find((x) => x.kind === 'keycap' && x.key && x.key[0] === r && x.key[1] === c);
  if (!p) return;
  pressAnims.push({ obj: p.obj, t0: performance.now() });
}

/* ------------------------------------------------------------------ *
 * 9. UI
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function renderSteps() {
  const list = $('stepList');
  list.innerHTML = STEPS.map((s, i) => `<li><button type="button" data-step="${i}" ${i === state.step ? 'aria-current="step"' : ''} class="${i < state.step ? 'done' : ''}"><span class="n">STEP ${i}</span>${esc(s.t)}</button></li>`).join('');
  const s = STEPS[state.step];
  $('stepCard').innerHTML = `<div class="kicker">STEP ${state.step} / ${STEPS.length - 1}</div><h2>${esc(s.t)}</h2><p>${esc(s.body)}</p><ul>${s.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="check"><strong>확인</strong> · ${esc(s.check)}</p>`;
  $('stepCount').textContent = `${state.step + 1} / ${STEPS.length}`;
  $('prevStep').disabled = state.step === 0;
  $('nextStep').disabled = state.step === STEPS.length - 1;
}
function goStep(i) {
  state.step = Math.max(0, Math.min(STEPS.length - 1, i));
  state.focus = null; syncFocusButtons();
  if (state.fault !== 'none') setFault('none', true);
  renderSteps();
  if (camera) {
    const v = STEPS[state.step].view;
    if (state.step >= 6 && v === 'iso') setToggle('bottomCase', true);
    setView(v);
  }
  refresh();
}

function renderFaults() {
  $('faultList').innerHTML = Object.entries(FAULTS).map(([id, f]) => `<label class="fault-opt${f.real ? ' real' : ''}"><input type="radio" name="fault" value="${id}" ${id === state.fault ? 'checked' : ''}><span><span class="t">${esc(f.t)}</span><span class="d">${esc(f.d)}</span></span></label>`).join('');
  renderFaultCard();
}
function renderFaultCard() {
  const f = FAULTS[state.fault];
  const card = $('faultCard');
  if (state.fault === 'none') {
    card.className = 'fault-card ok';
    card.innerHTML = '<dl><dt>현재 상태</dt><dd>정상 배선입니다. 오류를 선택하면 3D 모델에 위치가 빨간 고리로 표시되고, 아래 가상 입력 테스트 결과가 달라집니다.</dd></dl>';
    return;
  }
  card.className = 'fault-card';
  card.innerHTML = `<h3>${esc(f.t)}${f.real ? ' <small style="color:var(--warn)">· VOID9 실제 사례</small>' : ''}</h3><dl><dt>발생 위치</dt><dd>${esc(f.where)}</dd><dt>예상 증상</dt><dd>${esc(f.symptom)}</dd><dt>원인</dt><dd>${esc(f.cause)}</dd><dt>수정 방법</dt><dd>${esc(f.fix)}</dd></dl>`;
}
let usbTimer = null;
function setFault(id, silent) {
  state.fault = id;
  state.focus = null; syncFocusButtons();
  const r = document.querySelector(`input[name="fault"][value="${id}"]`);
  if (r) r.checked = true;
  renderFaultCard();
  if (!silent) $('selectedLine').textContent = id === 'none' ? '정상 배선 상태입니다.' : `오류 시뮬레이션: ${FAULTS[id].t}`;
  clearInterval(usbTimer); state.usbUp = true;
  if (id === 'gnd') usbTimer = setInterval(() => { state.usbUp = !state.usbUp; updateStuck(); }, 1600);
  updateStuck();
  refresh();
  if (!silent && camera && FAULTS[id].at) flyToPoint(FAULTS[id].at(), id === 'gnd' || id === 'wrongPin' ? 80 : 100);
  else if (!silent && camera && id === 'none') setView('bottomAngle');
  $('scanLog').textContent = id === 'none' ? '키를 눌러 보세요.' : `"${FAULTS[id].t}" 상태입니다. 키를 눌러 결과를 비교해 보세요.`;
}
function updateStuck() {
  document.querySelectorAll('.vkey').forEach((b) => {
    const r = +b.dataset.r, c = +b.dataset.c;
    b.classList.toggle('stuck', state.fault === 'short' && r === 0 && c === 1);
    b.disabled = false;
  });
  const vk = $('vkeys');
  vk.style.opacity = state.fault === 'gnd' && !state.usbUp ? '0.45' : '1';
  vk.title = state.fault === 'gnd' && !state.usbUp ? 'USB 연결 끊김 (가상)' : '';
}

function renderVKeys() {
  let h = '';
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) h += `<button type="button" class="vkey" data-r="${r}" data-c="${c}" aria-label="SW${swNo(r, c)} 누르기, 행 ${r} 열 ${c}">SW${swNo(r, c)}<small>R${r}·C${c}</small></button>`;
  $('vkeys').innerHTML = h;
}

function renderPins() {
  const rows = [...pinRows.map((p, r) => ({ ...p, cls: 'r' + r, to: `행 · ${p.keys.join(', ')} 다이오드 캐소드` })), ...pinCols.map((p, c) => ({ ...p, cls: 'c' + c, to: `열 · ${p.keys.join(', ')} 단자 1` }))];
  $('pinTable').innerHTML = rows.map((p) => `<tr><td class="${p.cls}"><span class="swatch"></span>${p.sig}</td><td><code>${p.q}</code></td><td><code>${esc(p.silk)}</code></td><td>${esc(p.to)}</td></tr>`).join('');
  $('jsonSnippet').textContent = `// VOID9 keyboard.json (발췌)\n"development_board": "${QMK.development_board}",\n"bootloader": "${QMK.bootloader}",\n"diode_direction": "${QMK.diode_direction}",\n"matrix_pins": {\n  "cols": ${JSON.stringify(QMK.matrix_pins.cols).replace(/,/g, ', ')},\n  "rows": ${JSON.stringify(QMK.matrix_pins.rows).replace(/,/g, ', ')}\n}`;
}

function showPart(part) {
  state.selected = part;
  refresh();
  const info = part.info ? part.info() : { title: part.name || '부품', rows: [] };
  $('partCard').innerHTML = `<h2>${esc(info.title)}</h2>${info.sub ? `<p class="hint">${esc(info.sub)}</p>` : ''}<dl>${info.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${info.focus ? `<p style="margin-top:12px"><button type="button" class="chip" data-focus-part="${info.focus}">이 배선만 강조</button></p>` : ''}`;
  $('selectedLine').textContent = `선택: ${info.title}`;
}

function setTab(id) {
  document.querySelectorAll('[role="tab"]').forEach((t) => {
    const on = t.id === 'tab-' + id;
    t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
}

function setToggle(name, val) {
  state.toggles[name] = val;
  const b = document.querySelector(`[data-toggle="${name}"]`);
  if (b) b.setAttribute('aria-pressed', String(val));
  refresh();
}
function syncFocusButtons() {
  document.querySelectorAll('[data-focus]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.focus === state.focus)));
}
function setFocus(f) {
  state.focus = state.focus === f ? null : f;
  if (state.focus && state.fault !== 'none') setFault('none', true);
  if (state.focus && state.step > 0 && state.step < 6) { state.step = 6; renderSteps(); }
  syncFocusButtons();
  refresh();
  const [k, n] = (state.focus || ':').split(':');
  $('selectedLine').textContent = state.focus ? `강조: ${k === 'row' ? '행 R' : '열 C'}${n} 배선 (같은 버튼을 다시 누르면 해제)` : '강조를 해제했습니다.';
}

function renderPartButtons() {
  const items = [['Pro Micro', (p) => p.kind === 'mcu' && p.groups.size === 1], ['SW5 스위치', (p) => p.kind === 'switch' && p.groups.has('key:1:1')], ['D5 다이오드', (p) => p.kind === 'diode' && p.groups.has('key:1:1') && p.alt === 'diode:normal'], ['R0 배선', (p) => p.kind === 'wire' && p.groups.has('row:0') && p.groups.has('rowwire')], ['C0 배선', (p) => p.kind === 'wire' && p.groups.has('col:0') && p.groups.has('colwire')], ['GND 연결선', (p) => p.kind === 'wire' && p.groups.has('gnd') && p.alt === 'gnd:normal'], ['케이스 상판', (p) => p.groups.has('topCase')], ['케이스 하판', (p) => p.groups.has('bottomCase')]];
  $('partButtons').innerHTML = items.map(([t], i) => `<button type="button" class="chip" data-quick="${i}">${t}</button>`).join('');
  $('partButtons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick]'); if (!b) return;
    const part = parts.find(items[+b.dataset.quick][1]);
    if (!part) return;
    if (part.groups.has('bottomCase')) { setToggle('bottomCase', true); if (state.step < 6 && state.step > 0) goStep(6); setView('iso'); }
    else if (!part.obj.visible && state.step < 6) goStep(6);
    showPart(part);
    if (camera && part.fit && !part.groups.has('case')) flyToPoint(part.fit, 60);
  });
}

function bindUI() {
  document.querySelector('.toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) setView(b.dataset.view);
    else if (b.dataset.toggle) setToggle(b.dataset.toggle, b.getAttribute('aria-pressed') !== 'true');
    else if (b.dataset.focus) setFocus(b.dataset.focus);
  });
  $('stepList').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) goStep(+b.dataset.step); });
  $('prevStep').addEventListener('click', () => goStep(state.step - 1));
  $('nextStep').addEventListener('click', () => goStep(state.step + 1));
  $('faultList').addEventListener('change', (e) => { if (e.target.name === 'fault') setFault(e.target.value); });
  $('vkeys').addEventListener('click', (e) => { const b = e.target.closest('.vkey'); if (b) pressKey(+b.dataset.r, +b.dataset.c); });
  $('partCard').addEventListener('click', (e) => { const b = e.target.closest('[data-focus-part]'); if (b) setFocus(b.dataset.focusPart); });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => {
      setTab(t.id.replace('tab-', ''));
      if (t.id === 'tab-faults' && state.step > 0 && state.step < 6) { state.step = 6; renderSteps(); refresh(); }
    });
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (j !== null) { tabs[j].focus(); tabs[j].click(); e.preventDefault(); }
    });
  });
}

/* ------------------------------------------------------------------ *
 * 10. 포인터 선택 · 키보드 조작
 * ------------------------------------------------------------------ */
function bindPointer() {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(parts.filter((p) => p.obj.visible).map((p) => p.obj), true)
      .filter((h) => h.object.visible && h.object.userData.part && h.object.material.opacity > 0.3);
    const hit = hits.find((h) => h.object.userData.part.kind !== 'case') || hits[0];
    if (!hit) return;
    const part = hit.object.userData.part;
    showPart(part);
    const t = part.info && part.info().test;
    if (t) pressKey(t[0], t[1], true);
  });
  viewport.addEventListener('keydown', (e) => {
    const off = camera.position.clone().sub(controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    let used = true;
    if (e.key === 'ArrowLeft') sph.theta -= 0.12;
    else if (e.key === 'ArrowRight') sph.theta += 0.12;
    else if (e.key === 'ArrowUp') sph.phi = Math.max(0.05, sph.phi - 0.12);
    else if (e.key === 'ArrowDown') sph.phi = Math.min(Math.PI - 0.05, sph.phi + 0.12);
    else if (e.key === '+' || e.key === '=') sph.radius = Math.max(controls.minDistance, sph.radius * 0.88);
    else if (e.key === '-' || e.key === '_') sph.radius = Math.min(controls.maxDistance, sph.radius * 1.12);
    else if (e.key === 'r' || e.key === 'R') { setView('iso'); e.preventDefault(); return; }
    else used = false;
    if (used) { e.preventDefault(); tween = null; camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph)); controls.update(); }
  });
}

/* ------------------------------------------------------------------ *
 * 11. 렌더 루프
 * ------------------------------------------------------------------ */
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  const prevScale = camera.aspect ? aspectScale() : 1;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
  labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const s = aspectScale() / prevScale;
  if (Math.abs(s - 1) > 0.01) { camera.position.sub(controls.target).multiplyScalar(s).add(controls.target); }
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function loop(now) {
  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.dur), e = ease(k);
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
    camera.position.lerpVectors(tween.fromP, tween.toP, e);
    if (k >= 1) tween = null;
  }
  controls.update();
  // 하이라이트 맥동
  if (hiCache && !REDUCED) {
    const pulse = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(now / 260));
    for (const p of parts) if (p.obj.visible && state.selected !== p && p.mats[0] && p.mats[0].emissiveIntensity > 0 && inSet(p, hiCache.set)) for (const m of p.mats) m.emissiveIntensity = pulse;
  }
  if (faultMarker && faultMarker.visible) {
    const s = REDUCED ? 1 : 1 + 0.18 * Math.sin(now / 200);
    faultMarker.scale.setScalar(s);
  }
  // 키 누름 애니메이션
  for (let i = pressAnims.length - 1; i >= 0; i--) {
    const a = pressAnims[i], t = (now - a.t0) / 260;
    if (t >= 1) { a.obj.position.y = 0; pressAnims.splice(i, 1); continue; }
    a.obj.position.y = -3.6 * Math.sin(Math.PI * Math.min(1, t));
  }
  // 라벨 위치 (카메라가 아래면 스위치 라벨을 밑면으로)
  const below = camera.position.y < controls.target.y;
  const near = camera.position.distanceTo(V(PM.x, PAD_Y, PM.z)) < 110;
  const seeInside = below || !state.toggles.topCase;
  for (const l of labels) {
    if (l.kind === 'sw') { l.obj.position.copy(below ? l.under : l.base); continue; }
    let v = l.baseVis;
    if (l.kind === 'line' || l.kind === 'pinUsed') v = v && seeInside;
    if (l.kind === 'pin') v = v && seeInside && near;
    l.obj.visible = v;
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

/* ------------------------------------------------------------------ *
 * 12. 시작
 * ------------------------------------------------------------------ */
renderSteps();
renderFaults();
renderVKeys();
renderPins();
bindUI();

if (initThree()) {
  buildCase();
  buildSwitches();
  buildMatrixWiring();
  buildProMicro();
  buildFaultMarker();
  renderPartButtons();
  bindPointer();
  new ResizeObserver(resize).observe(viewport);
  resize();
  setView('iso', true);
  refresh();
  renderer.setAnimationLoop(loop);
  window.__void9 = { state, parts, QMK, pmPin, setView, setFault, goStep, pressKey, evaluate };
}
