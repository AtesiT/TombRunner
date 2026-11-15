import * as THREE from 'three';

// ============================== CONFIG ==============================
const CFG = {
  playerRadius: 0.34,
  playerHeight: 1.6,
  walkSpeed: 5.0,
  runSpeed: 9.0,
  jumpVelocity: 9.0,
  gravity: 30.0,
  accel: 14.0,
  airAccel: 4.0,
  stepHeight: 0.55,
  camDist: 5.0,
  camHeight: 1.35,
  camNear: 0.6,
  fallKillY: -20,
};

// ============================== INPUT ==============================
const keys = {};
const pointerLocked = { value: false };
let yaw = 0;   // характер / камера смотреть вдоль этого угла (вокруг Y)
let pitch = 0; // наклон камеры вверх-вниз

function onKeyDown(e) {
  keys[e.code] = true;
}
function onKeyUp(e) {
  keys[e.code] = false;
}
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
});

const canvas = document.getElementById('canvas');
const startBtn = document.getElementById('startBtn');
const menuEl = document.getElementById('menu');
const hudEl = document.getElementById('hud');
const artCountEl = document.getElementById('artCount');
const msgEl = document.getElementById('msg');

startBtn.addEventListener('click', () => {
  canvas.focus();
  canvas.requestPointerLock();
});
canvas.addEventListener('click', () => {
  if (!pointerLocked.value) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked.value = document.pointerLockElement === canvas;
  menuEl.classList.toggle('hidden', pointerLocked.value);
  hudEl.classList.toggle('hidden', !pointerLocked.value);
  if (!pointerLocked.value) {
    for (const k in keys) keys[k] = false;
  }
});
document.addEventListener('pointerlockerror', () => {
  console.warn('Pointer lock не доступен');
});

window.addEventListener('mousemove', (e) => {
  if (!pointerLocked.value) return;
  const sens = 0.0022;
  yaw -= e.movementX * sens;
  pitch -= e.movementY * sens;
  pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
});

// целевая скорость перемещения в мировом пространстве (относительно угла взгляда камеры)
function getTargetVelocity() {
  const v = new THREE.Vector3();
  if (keys['KeyW']) v.z -= 1;
  if (keys['KeyS']) v.z += 1;
  if (keys['KeyD']) v.x += 1;
  if (keys['KeyA']) v.x -= 1;
  if (v.lengthSq() > 0) v.normalize();
  const s = (keys['ShiftLeft'] || keys['ShiftRight']) ? CFG.runSpeed : CFG.walkSpeed;
  v.multiplyScalar(s);
  const c = Math.cos(yaw),
    si = Math.sin(yaw);
  return new THREE.Vector3(v.x * c - v.z * si, 0, v.x * si + v.z * c);
}

// ============================== LEVEL / BOXES ==============================
// Боксы уровня: {min, max, type, mesh}
// type: 'floor' | 'pit' (смвкерать смсмерть при падении) | 'wall' | 'platform' | 'stairs'
const boxes = [];

function addBox(minX, minY, minZ, maxX, maxY, maxZ, color, type, emissive = 0) {
  const min = new THREE.Vector3(minX, minY, minZ);
  const max = new THREE.Vector3(maxX, maxY, maxZ);
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    roughness: 0.8,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  boxes.push({ min, max, type, mesh });
}

// ============================== THREE SETUP ==============================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d14);
scene.fog = new THREE.FogExp2(0x0b0d14, 0.045);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const hemi = new THREE.HemisphereLight(0xaaaaaa, 0x222222, 0.7);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(12, 20, 8);
sun.castShadow = true;
scene.add(sun);

// ============================== ПОСТРОЙКА УРОВНЯ ==============================
const START_POS = new THREE.Vector3(-14, 0.8, 0);

// Пол (камни храма) с ямой в центре
addBox(-40, 0, -40, -9, 0.05, 40, 0x6e6e72, 'floor');
addBox(9, 0, -40, 40, 0.05, 40, 0x6e6e72, 'floor');
addBox(-9, 0, -40, 9, 0.05, -10, 0x6e6e72, 'floor');
addBox(-9, 0, 10, 9, 0.05, 40, 0x6e6e72, 'floor');
// Яма (смерть при падении)
addBox(-9, -0.05, -10, 9, 0.05, 10, 0x141018, 'pit');

// Внешние стены
addBox(-40, 0.05, -40, 40, 4.5, -39, 0x827460, 'wall');
addBox(-40, 0.05, 39, 40, 4.5, 40, 0x827460, 'wall');
addBox(-40, 0.05, -39, -39, 4.5, 40, 0x827460, 'wall');
addBox(39, 0.05, -39, 40, 4.5, 40, 0x827460, 'wall');
// Внутренние перегородки
addBox(-24, 0.05, -20, -20, 4.5, 20, 0x827460, 'wall');
addBox(20, 0.05, -20, 24, 4.5, 20, 0x827460, 'wall');

// Колонны
addBox(-30, 0.05, -30, -26, 6, -26, 0x8c7d68, 'wall');
addBox(26, 0.05, -30, 30, 6, -26, 0x8c7d68, 'wall');
addBox(-30, 0.05, 26, -26, 6, 30, 0x8c7d68, 'wall');
addBox(26, 0.05, 26, 30, 6, 30, 0x8c7d68, 'wall');

// Возвышенная платформа с лестницей (артефакт на ней)
addBox(10, 0, -22, 32, 3, -8, 0x9a8a72, 'platform');
// лестница: ступеньки
for (let i = 0; i < 5; i++) {
  const h = (i + 1) * 0.6;
  addBox(10, h - 0.6, -22 + i * 4.8, 32, h, -22 + (i + 1) * 4.8, 0x9a8a72, 'stairs');
}
// вторая платформа поодаль
addBox(-30, 0, 14, -10, 2.4, 34, 0x9a8a72, 'platform');
for (let i = 0; i < 4; i++) {
  const h = (i + 1) * 0.6;
  addBox(-30, h - 0.6, 14 + i * 5, -10, h, 14 + (i + 1) * 5, 0x9a8a72, 'stairs');
}

// ============================== ИГРОК / МЕШ ==============================
const pos = new THREE.Vector3().copy(START_POS);
const vel = new THREE.Vector3();
let grounded = false;
let onArtifactCooldown = 0;

const playerGroup = new THREE.Group();
scene.add(playerGroup);

const skinMat = new THREE.MeshStandardMaterial({ color: 0x3d2a1f });
const clothMat = new THREE.MeshStandardMaterial({ color: 0x355040 });
const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a1410 });

const torso = new THREE.Mesh(
  new THREE.CylinderGeometry(0.26, 0.26, 0.85, 16),
  clothMat
);
torso.position.y = 0.45;
const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 16), skinMat);
head.position.y = 1.02;
const hair = new THREE.Mesh(new THREE.SphereGeometry(0.235, 16, 16), hairMat);
hair.position.y = 1.02;
hair.scale.set(1, 0.85, 1.1);
const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.72, 12), clothMat);
legL.position.set(-0.13, 0.1, 0);
const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.72, 12), clothMat);
legR.position.set(0.13, 0.1, 0);

playerGroup.add(torso, head, hair, legL, legR);

// ============================== АРТЕФАКТЫ ==============================
const artifacts = [];
const TOTAL_ARTIFACTS = 3;
let collected = 0;

function addArtifact(x, y, z) {
  const geo = new THREE.IcosahedronGeometry(0.4, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    emissive: 0x443300,
    metalness: 0.6,
    roughness: 0.25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  scene.add(mesh);
  artifacts.push({ mesh, baseY: y, collected: false });
}

addArtifact(21, 3.2, -15); // на платформе 1
addArtifact(-20, 2.6, 24); // на платформе 2
addArtifact(-14, 0.4, 30); // в углу уровня

// ============================== ФИЗИКА (сфера против боксов) ==============================
const sphereCenter = new THREE.Vector3();

function collideSphereBox(center, radius, box) {
  const clamped = center.clone().clamp(box.min, box.max);
  const diff = center.clone().sub(clamped);
  const distSq = diff.lengthSq();
  if (distSq < radius * radius && distSq > 0.0001) {
    const dist = Math.sqrt(distSq);
    const normal = diff.divideScalar(dist);
    const depth = radius - dist;
    return { hit: true, normal, depth };
  }
  return { hit: false };
}

// вертикальная проекция: какая коробка находится прямо под сферой (опора)
function supportBox(center) {
  for (const box of boxes) {
    if (
      center.x >= box.min.x &&
      center.x <= box.max.x &&
      center.z >= box.min.z &&
      center.z <= box.max.z
    ) {
      const top = box.max.y;
      const d = center.y - top; // центр сферы над верхней гранью
      if (d > -0.02 && d <= CFG.playerRadius + 0.08) return { box, d };
    }
  }
  return null;
}

function resolveHorizontal() {
  sphereCenter.set(pos.x, CFG.playerRadius, pos.z); // упрощённо: проверяем по высоте талии
  sphereCenter.y = pos.y + CFG.playerRadius;

  let slides = [];
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const box of boxes) {
      if (box.type === 'pit') continue;
      const hit = collideSphereBox(sphereCenter, CFG.playerRadius, box);
      if (!hit) continue;
      // ступенька: если коробка выше ног не более stepHeight — поднимаемся
      if (vel.y <= 0 && box.max.y > pos.y && box.max.y - pos.y <= CFG.stepHeight + 0.05) {
        pos.y = box.max.y;
        sphereCenter.y = pos.y + CFG.playerRadius;
        continue;
      }
      // отталкивание по нормали
      pos.x += hit.normal.x * hit.depth;
      pos.z += hit.normal.z * hit.depth;
      sphereCenter.x = pos.x;
      sphereCenter.z = pos.z;
      // скольжение: убираем нормальную компоненту скорости
      const dot = vel.x * hit.normal.x + vel.z * hit.normal.z;
      if (dot < 0) {
        vel.x -= hit.normal.x * dot;
        vel.z -= hit.normal.z * dot;
      }
      moved = true;
    }
    if (!moved) break;
  }
}

function resolveVertical() {
  sphereCenter.set(pos.x, pos.y + CFG.playerRadius, pos.z);

  let hitGround = null;
  for (const box of boxes) {
    if (box.type === 'pit') continue;
    const clampedX = Math.max(box.min.x, Math.min(pos.x, box.max.x));
    const clampedZ = Math.max(box.min.z, Math.min(pos.z, box.max.z));
    const dx = pos.x - clampedX;
    const dz = pos.z - clampedZ;
    const distH = Math.sqrt(dx * dx + dz * dz);
    const top = box.max.y;
    const bottom = box.min.y;
    const centerY = pos.y + CFG.playerRadius;

    // описание сверху (голова упирается в низ коробки)
    if (distH < CFG.playerRadius && centerY < bottom && centerY + vel.y * 0.02 > bottom) {
      pos.y = bottom - CFG.playerRadius;
      vel.y = Math.min(vel.y, 0);
    }
    // опора снизу
    if (distH < CFG.playerRadius + 0.02) {
      const d = centerY - top;
      if (d > -0.05 && d <= CFG.playerRadius + 0.12) {
        if (!hitGround || top > hitGround.box.max.y) hitGround = { box, d, top };
      }
    }
  }

  if (hitGround) {
    if (!grounded) {
      grounded = true;
      // поставить ноги ровно на грань
      pos.y = hitGround.top - CFG.playerRadius;
    }
    if (vel.y < 0) vel.y = 0;
  } else {
    grounded = false;
  }
}

function respawn() {
  pos.copy(START_POS);
  vel.set(0, 0, 0);
  grounded = false;
  showMsg('Респавн', 1200);
}

let msgTimer = 0;
function showMsg(text, ms) {
  msgEl.textContent = text;
  msgTimer = ms;
}

// ============================== КАМЕРА ==============================
function segmentBoxHit(p1, p2, box) {
  // slab-метод для отрезка p1->p2
  let tMin = 0,
    tMax = 1;
  const d = new THREE.Vector3().subVectors(p2, p1);
  const axes = [
    { o: p1.x, dir: d.x, min: box.min.x, max: box.max.x },
    { o: p1.y, dir: d.y, min: box.min.y, max: box.max.y },
    { o: p1.z, dir: d.z, min: box.min.z, max: box.max.z },
  ];
  for (const a of axes) {
    if (Math.abs(a.dir) < 1e-6) {
      if (a.o < a.min || a.o > a.max) return null;
    } else {
      const t1 = (a.min - a.o) / a.dir;
      const t2 = (a.max - a.o) / a.dir;
      let lo = Math.min(t1, t2),
        hi = Math.max(t1, t2);
      tMin = Math.max(tMin, lo);
      tMax = Math.min(tMax, hi);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

function updateCamera() {
  const eye = pos.clone().add(new THREE.Vector3(0, CFG.playerHeight * 0.55, 0));
  const offset = new THREE.Vector3(0, CFG.camHeight, -CFG.camDist);
  offset.applyEuler(new THREE.Euler(0, yaw, 0));
  const ideal = eye.clone().add(offset);

  let dist = CFG.camDist;
  for (const box of boxes) {
    if (box.type === 'pit') continue;
    const t = segmentBoxHit(eye, ideal, box);
    if (t !== null && t > 0.02 && t < 1) {
      dist = t * CFG.camDist - CFG.camNear;
    }
  }
  dist = Math.max(CFG.camNear, dist);
  const camPos = eye.clone().add(offset.clone().setLength(dist));
  if (camPos.y < 0.8) camPos.y = 0.8;

  camera.position.copy(camPos);
  const look = pos.clone().add(new THREE.Vector3(0, 1.0, 0));
  camera.lookAt(look);
}

// ============================== УПРАВЛЕНИЕ / ОБНОВЛЕНИЕ ==============================
function updateGame(dt) {
  if (!pointerLocked.value) return;

  const targetVel = getTargetVelocity();
  const acc = grounded ? CFG.accel : CFG.airAccel;
  vel.x += (targetVel.x - vel.x) * Math.min(1, acc * dt);
  vel.z += (targetVel.z - vel.z) * Math.min(1, acc * dt);

  pos.x += vel.x * dt;
  pos.z += vel.z * dt;
  resolveHorizontal();

  vel.y -= CFG.gravity * dt;
  pos.y += vel.y * dt;
  resolveVertical();

  if (grounded && keys['Space']) {
    vel.y = CFG.jumpVelocity;
    grounded = false;
  }

  if (pos.y < CFG.fallKillY) respawn();

  // артефакты
  sphereCenter.set(pos.x, pos.y + CFG.playerRadius * 0.5, pos.z);
  for (const art of artifacts) {
    if (art.collected) continue;
    const d = sphereCenter.distanceTo(art.mesh.position);
    if (d < 1.1) {
      art.collected = true;
      scene.remove(art.mesh);
      collected++;
      artCountEl.textContent = String(collected);
      showMsg('Артефакт найден!', 1000);
      if (collected >= TOTAL_ARTIFACTS) {
        showMsg('Все артефакты собраны — прототип завершён', 3000);
      }
    }
  }

  // анимация меша игрока
  const moving = vel.x !== 0 || vel.z !== 0;
  const bob = moving && grounded ? Math.sin(performance.now() * 0.012) * 0.04 : 0;
  playerGroup.position.set(pos.x, pos.y + CFG.playerHeight / 2 + bob, pos.z);
  playerGroup.rotation.y = yaw;
  torso.rotation.z = Math.sin(performance.now() * 0.015) * 0.05;
  legL.rotation.x = Math.sin(performance.now() * 0.015) * 0.3;
  legR.rotation.x = Math.sin(performance.now() * 0.015 + Math.PI) * 0.3;

  if (msgTimer > 0) {
    msgTimer -= dt * 1000;
    if (msgTimer <= 0) msgEl.textContent = '';
  }

  updateCamera();
}

// ============================== АРТЕФАКТЫ: анимация + рендер ==============================
let lastTime = 0;
function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (t - lastTime) / 1000);
  lastTime = t;

  updateGame(dt);

  for (const art of artifacts) {
    if (art.collected) continue;
    const time = t * 0.0015;
    art.mesh.position.y = art.baseY + Math.sin(time * 2) * 0.18;
    art.mesh.rotation.y += 0.015;
    art.mesh.rotation.x += 0.01;
  }

  renderer.render(scene, camera);
}

// ============================== RESIZE ==============================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// старт
lastTime = performance.now();
requestAnimationFrame(animate);
