// 自绘滚动条：把原生的藏掉（它占宽度、也配不上皮肤），另画一根细滑块浮在内容右侧。
// 轨道是 fixed 挂在 body 上、按元素的屏幕矩形定位，所以不用改任何现有布局，也不占一像素宽。
// 滚动 / 鼠标进来时显示，停 800 毫秒淡出；滑块可以拖。
const FADE_MS = 800, WIDTH = 4, PAD = 4, MIN_THUMB = 24;

export function attachScrollbar(el, { z = 35 } = {}) {
  if (!el || el.dataset.sb) return;
  el.dataset.sb = '1';
  el.classList.add('scroll-clean');

  const track = document.createElement('div');
  track.className = 'sb-track';
  track.style.zIndex = z;
  track.style.width = WIDTH + 'px';
  const thumb = document.createElement('div');
  thumb.className = 'sb-thumb';
  track.appendChild(thumb);
  document.body.appendChild(track);

  let raf = 0, fadeTimer = 0, grab = null;
  function show() {
    track.classList.add('on');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { if (!grab) track.classList.remove('on'); }, FADE_MS);
  }
  function layout() {
    raf = 0;
    const r = el.getBoundingClientRect();
    const over = el.scrollHeight - el.clientHeight;
    const need = over > 2 && r.width > 0 && r.height > 0;   // 内容不够高（或面板收起来了）就不画
    track.hidden = !need;
    if (!need) return;
    const h = Math.max(MIN_THUMB, r.height - PAD * 2);
    track.style.left = (r.right - WIDTH - 3) + 'px';
    track.style.top = (r.top + PAD) + 'px';
    track.style.height = h + 'px';
    const th = Math.max(MIN_THUMB, h * el.clientHeight / el.scrollHeight);
    thumb.style.height = th + 'px';
    thumb.style.transform = `translateY(${(el.scrollTop / over) * (h - th)}px)`;
  }
  const sync = () => { if (!raf) raf = requestAnimationFrame(layout); };

  el.addEventListener('scroll', () => { sync(); show(); }, { passive: true });
  el.addEventListener('pointerenter', () => { sync(); show(); });
  addEventListener('resize', sync);
  new ResizeObserver(sync).observe(el);
  // 内容变了（装包、换分类、贴纸条重排）也要重算；用 rAF 节流，一帧最多算一次
  new MutationObserver(sync).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  sync();

  thumb.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const h = Math.max(MIN_THUMB, el.getBoundingClientRect().height - PAD * 2);
    grab = { y: e.clientY, top: el.scrollTop, span: Math.max(1, h - thumb.offsetHeight), over: el.scrollHeight - el.clientHeight };
    try { thumb.setPointerCapture(e.pointerId); } catch {}
    show();
  });
  thumb.addEventListener('pointermove', e => {
    if (!grab) return;
    el.scrollTop = grab.top + (e.clientY - grab.y) / grab.span * grab.over;
  });
  const done = () => { if (grab) { grab = null; show(); } };
  thumb.addEventListener('pointerup', done);
  thumb.addEventListener('pointercancel', done);

  return { update: sync, destroy() { track.remove(); delete el.dataset.sb; } };
}
