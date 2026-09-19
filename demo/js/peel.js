// 撕贴纸：整个窗口上盖一层透明的 WebGL 画布，只画"正在撕的那一张"。其余贴纸仍是普通图片。
// 一切几何都是屏幕像素（client 坐标）：画布缩放、贴纸条上的缩略图都不用另算投影，调用方换算好尺寸和位置传进来。
// 卷曲模型参考 CatsJuice/sticker-forge（MIT）：越过折线的部分绕半径 R 的圆柱卷起来，
// 卷过去露出白色离型纸背面；还贴着的部分完全不动、不拉伸。
import * as THREE from '../vendor/three.module.js';

const PI = Math.PI;
export const DETACH_AT = 0.74;   // 揭过这么多就整张离开、拿在手上；不到就松手弹回去
const MIN_PULL = 30;              // 至少拖这么远（屏幕像素）才允许整张离开，小贴纸也要看得到卷起来

// 网格坐标：贴纸中心为原点、y 向上。uOrigin/uDir 描述"从哪条边、朝哪个方向揭"，uFront 是折线走了多远
const vertexShader = /* glsl */ `
  uniform vec2 uCenter;
  uniform float uRot;
  uniform vec2 uOrigin;
  uniform vec2 uDir;
  uniform float uFront;
  uniform float uR;
  varying vec2 vUv;
  varying float vAngle;
  const float PI = 3.14159265;
  void main() {
    vec2 p = position.xy;
    vec3 q = vec3(p, 0.0);
    float a = 0.0;
    float along = dot(p - uOrigin, uDir);
    float s = uFront - along;               // 这一点越过折线多远（沿纸面量）
    if (uFront > 0.0 && s > 0.0) {
      a = min(s / uR, PI);
      float n = s <= PI * uR ? uFront - uR * sin(a) : uFront + (s - PI * uR);
      q.xy = p + uDir * (n - along);
      q.z = s <= PI * uR ? uR * (1.0 - cos(a)) : 2.0 * uR;
    }
    vAngle = a;
    vUv = uv;
    float c = cos(uRot), sn = sin(uRot);
    vec2 w = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y) + uCenter;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, q.z, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vAngle;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (t.a < 0.4) discard;                 // 透明处不画：正反面都保留刀模轮廓
    vec3 col = gl_FrontFacing ? t.rgb : vec3(0.969, 0.961, 0.949);   // 背面：略暖的白色离型纸
    float lifted = step(0.0001, vAngle);
    float crest = exp(-pow((vAngle - 1.5708) / 0.55, 2.0)) * lifted;  // 卷起的脊上一条亮带
    float root = (1.0 - smoothstep(0.0, 0.5, vAngle)) * lifted;       // 折线根部略暗
    col = col * (1.0 - 0.14 * root) + 0.12 * crest;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createPeeler(canvas) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); }
  catch (e) { console.warn('WebGL 不可用，贴纸改为直接拿起', e); return null; }
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, innerWidth, 0, -innerHeight, -100, 100);   // 世界 y 向上 = 屏幕 y 取负

  const U = {
    uCenter: { value: new THREE.Vector2() }, uRot: { value: 0 },
    uOrigin: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) },
    uFront: { value: 0 }, uR: { value: 12 }, uMap: { value: null },
  };
  let geo = new THREE.PlaneGeometry(1, 1);
  const face = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: U, vertexShader, fragmentShader, side: THREE.DoubleSide }));
  face.frustumCulled = false;   // 顶点在着色器里挪了位置，包围盒不准
  face.visible = false;
  scene.add(face);

  const textures = new Map();
  // 按原大或放大显示时用最近邻（像素风不插值）；缩小显示时用平滑采样 + 多级纹理，否则锯齿闪烁
  const textureFor = (key, img, smooth) => {
    key += smooth ? '#s' : '#n';
    let t = textures.get(key);
    if (!t) {
      // 不能直接把页面上的 <img> 交给 Three.js：它读 img.width 当贴图尺寸，而被样式缩放过的 <img>
      // 的 width 是"显示出来的宽度"（缩小一半就是一半），和图片文件本身的尺寸对不上 → WebGL 报错、贴图是空的。
      // 所以先按文件原尺寸拷到一块画布上再用
      const src = document.createElement('canvas');
      src.width = img.naturalWidth;
      src.height = img.naturalHeight;
      src.getContext('2d').drawImage(img, 0, 0);
      t = new THREE.Texture(src);
      t.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
      t.minFilter = smooth ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
      t.generateMipmaps = smooth;
      t.needsUpdate = true;
      textures.set(key, t);
    }
    return t;
  };

  const draw = () => renderer.render(scene, camera);
  let active = null, raf = 0, pending = null;

  // 播一段动画；新的一次撕开始、或者 flush() 时，没播完的直接跳到结尾。
  // 逐帧回调在窗口失焦、面板切到后台时会被浏览器暂停或降速，所以另设一个普通定时器兜底：到点必定播完，
  // 不然贴纸会一直停在"交接中"（图片隐藏、WebGL 那张也不跟手）
  function animate(ms, step) {
    return new Promise(done => {
      const t0 = performance.now();
      const guard = setTimeout(() => finish(), ms + 60);
      const finish = () => { clearTimeout(guard); cancelAnimationFrame(raf); pending = null; step(1); done(); };
      const tick = now => {
        const k = Math.min(1, (now - t0) / ms);
        if (k >= 1) return finish();
        step(k); draw();
        raf = requestAnimationFrame(tick);
      };
      pending = finish;
      raf = requestAnimationFrame(tick);
    });
  }
  function end(st) {
    if (active !== st) return;
    active = null;
    face.visible = false;
    draw();
  }

  // 画布盖满窗口、按设备像素比画。画布再怎么缩放也不影响它：撕纸几何全是屏幕像素，画布永远不超过窗口 × dpr
  function resize() {
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.right = innerWidth; camera.bottom = -innerHeight;
    camera.updateProjectionMatrix();
    draw();
  }

  // 开始撕：key/img 是贴纸图，w/h 屏幕上的显示尺寸，smooth 是否平滑采样，c 中心（屏幕坐标），rot 角度，
  // grab 按下点（贴纸自身坐标、屏幕像素、y 向下），sil 轮廓（同一坐标系）
  function begin({ key, img, w, h, smooth, c, rot, grab, sil }) {
    pending?.();
    geo.dispose();
    const seg = v => Math.min(160, Math.max(8, Math.ceil(v / 3)));
    geo = new THREE.PlaneGeometry(w, h, seg(w), seg(h));
    face.geometry = geo;
    U.uMap.value = textureFor(key, img, smooth);
    U.uCenter.value.set(c.x, -c.y);
    U.uRot.value = -rot * PI / 180;
    U.uR.value = Math.max(5, Math.min(24, 0.12 * Math.min(w, h)));
    U.uFront.value = 0;
    face.visible = true;
    const st = { dir: null, front: 0 };
    active = st;
    draw();

    return {
      // 手指相对按下点挪了 (dx, dy)（贴纸自身坐标）→ 返回揭起进度 0～1
      update(dx, dy) {
        const len = Math.hypot(dx, dy);
        if (len < 3) { st.front = U.uFront.value = 0; draw(); return 0; }
        let nx = dx / len, ny = dy / len;
        // 往哪个方向拽都能撕：往外拽在真实里就是把边缘掀起来，折线照样往贴纸里面走。
        // 所以朝外的方向镜像成朝里，揭起的量按拖动的总长度算（真鼠标一步能跨几百像素，方向很随意）
        let ix = sil.centroid.x - grab.x, iy = sil.centroid.y - grab.y;
        const il = Math.hypot(ix, iy) || 1; ix /= il; iy /= il;
        let inward = nx * ix + ny * iy;
        if (inward < 0) { nx -= 2 * inward * ix; ny -= 2 * inward * iy; inward = -inward; }
        if (inward < 0.35) { nx += ix * (0.35 - inward); ny += iy * (0.35 - inward); }   // 贴着边横着拖也往里偏一点
        // 方向做一点平滑，免得在轮廓拐角处跳
        if (st.dir) { nx = st.dir.x * 0.6 + nx * 0.4; ny = st.dir.y * 0.6 + ny * 0.4; }
        const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
        st.dir = { x: nx, y: ny };

        const e = sil.backToEdge(grab, st.dir);                 // 手指离身后那条边多远
        const o = { x: grab.x - nx * e, y: grab.y - ny * e };    // 揭起从这条边开始
        const R = U.uR.value, want = e + len;
        // 找折线位置：让手指捏住的那一点正好跟着手指走（位置随折线单调变化，二分就行）
        const pinchAt = f => { const s = f - e; return s <= 0 ? e : s <= PI * R ? f - R * Math.sin(s / R) : 2 * f - e - PI * R; };
        let lo = 0, hi = want + PI * R;
        for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (pinchAt(m) < want) lo = m; else hi = m; }
        st.front = hi;

        U.uOrigin.value.set(o.x, -o.y);
        U.uDir.value.set(nx, -ny);
        U.uFront.value = st.front;
        draw();
        const progress = Math.min(1, st.front / Math.max(1, sil.maxAlong(o, st.dir)));
        return len < MIN_PULL ? Math.min(progress, DETACH_AT - 0.01) : progress;
      },
      // 贴纸中心挪到 (x, y)（屏幕坐标）；展平动画进行中只更新终点，由动画去追
      moveTo(x, y) {
        if (st.target) { st.target = { x, y }; return; }
        U.uCenter.value.set(x, -y); draw();
      },
      // 没揭下来就松手：弹回贴平
      release() {
        const f0 = U.uFront.value;
        return animate(260, k => { U.uFront.value = f0 * Math.pow(1 - k, 3); }).then(() => end(st));
      },
      // 揭下来了：卷边展平，同时整张滑到 (x, y)——让捏住的那一点落在指尖下；然后交给普通图片接着跟手
      detach(x, y) {
        const f0 = U.uFront.value, c0 = { x: U.uCenter.value.x, y: -U.uCenter.value.y };
        st.target = { x, y };
        return animate(180, k => {
          const e = 1 - (1 - k) * (1 - k);
          U.uFront.value = f0 * (1 - e);
          U.uCenter.value.set(c0.x + (st.target.x - c0.x) * e, -(c0.y + (st.target.y - c0.y) * e));
        }).then(() => end(st));
      },
    };
  }

  // 正在播的动画立刻播完（松手时用，交接不等动画）
  const flush = () => pending?.();

  return { begin, resize, flush };
}
