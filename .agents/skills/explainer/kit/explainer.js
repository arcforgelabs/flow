/* Explainer runtime (explainers.md). Data: window.EX = {"<key>": {t, l, d, x: []}}.
   Items: any element with data-ex="<key>". Facts lists: <details class="ex-facts" data-def="…"> in a section.
   Rail: <nav class="ex-rail"></nav>, filled from .ex-section[id] heads. */
(function () {
  var EX = window.EX || {};
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pop = document.createElement('div');
  pop.className = 'ex-pop'; pop.hidden = true; pop.setAttribute('role', 'dialog');
  pop.innerHTML = '<div class="ex-pop-l"></div><h4><span></span><button type="button" aria-label="Close">×</button></h4><p class="ex-def"></p><ol></ol>';
  document.body.appendChild(pop);
  var cur = null;
  function close() { pop.hidden = true; if (cur) { cur.setAttribute('aria-expanded', 'false'); cur.focus({ preventScroll: true }); } cur = null; }
  function open(el) {
    if (cur === el) { close(); return; }
    var d = EX[el.dataset.ex]; if (!d) return;
    pop.querySelector('.ex-pop-l').textContent = d.l || ''; pop.querySelector('.ex-pop-l').hidden = !d.l;
    pop.querySelector('h4 span').textContent = d.t;
    pop.querySelector('.ex-def').textContent = d.d;
    var ol = pop.querySelector('ol'); ol.textContent = '';
    (d.x || []).forEach(function (f) { var li = document.createElement('li'); li.textContent = f; ol.appendChild(li); });
    ol.hidden = !(d.x && d.x.length);
    pop.hidden = false;
    var r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(16, Math.min(r.left, document.documentElement.clientWidth - w - 16)) + scrollX;
    var top = r.bottom + 6 + scrollY;
    if (r.bottom + 6 + h > innerHeight && r.top - 6 - h > 0) top = r.top - 6 - h + scrollY;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    if (cur) cur.setAttribute('aria-expanded', 'false');
    cur = el; el.setAttribute('aria-expanded', 'true');
  }
  document.querySelectorAll('[data-ex]').forEach(function (el) {
    el.setAttribute('aria-haspopup', 'dialog'); el.setAttribute('aria-expanded', 'false');
    if (!/^(BUTTON|A)$/.test(el.tagName)) { el.setAttribute('tabindex', '0'); el.setAttribute('role', 'button'); }
    if (!el.getAttribute('aria-label') && EX[el.dataset.ex]) el.setAttribute('aria-label', EX[el.dataset.ex].t);
  });
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-ex]');
    if (el && !pop.contains(el)) { e.stopPropagation(); open(el); return; }
    if (!pop.hidden && (!pop.contains(e.target) || e.target.closest('h4 button'))) close();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pop.hidden) { close(); return; }
    var el = e.target.closest && e.target.closest('[data-ex]');
    if (el && el.getAttribute('role') === 'button' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(el); }
  });

  // FactsList: every fact comes from an item and leads back to it
  function go(el) {
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    var last = -1, still = 0, t0 = performance.now();
    (function wait() {
      if (scrollY === last) still++; else still = 0; last = scrollY;
      if (still >= 4 || performance.now() - t0 > 1500) {
        el.classList.remove('ex-pulse'); void el.getBoundingClientRect(); el.classList.add('ex-pulse');
        setTimeout(function () { el.classList.remove('ex-pulse'); }, 1200);
        if (cur !== el) open(el); return;
      }
      requestAnimationFrame(wait);
    })();
  }
  document.querySelectorAll('details.ex-facts').forEach(function (det) {
    var scope = det.closest('.ex-section') || document, seen = {}, facts = [];
    scope.querySelectorAll('[data-ex]').forEach(function (el) {
      var d = EX[el.dataset.ex]; if (!d) return;
      (d.x || []).forEach(function (f) { if (!seen[f]) { seen[f] = 1; facts.push({ f: f, el: el, t: d.t }); } });
    });
    det.textContent = '';
    var s = document.createElement('summary'); s.textContent = 'Facts · ' + facts.length; det.appendChild(s);
    if (det.dataset.def) { var p = document.createElement('p'); p.className = 'ex-def'; p.textContent = det.dataset.def; det.appendChild(p); }
    var ol = document.createElement('ol');
    facts.forEach(function (o, i) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'ex-fx';
      b.innerHTML = '<i></i><b></b><em></em>';
      b.children[0].textContent = i + 1; b.children[1].textContent = o.f; b.children[2].textContent = o.t;
      b.addEventListener('click', function (e) { e.stopPropagation(); go(o.el); });
      li.appendChild(b); ol.appendChild(li);
    });
    det.appendChild(ol);
  });

  // TickRail
  var rail = document.querySelector('.ex-rail');
  if (rail) {
    var secs = [].slice.call(document.querySelectorAll('.ex-section[id]')).filter(function (s) { return s.querySelector('.ex-head h2'); });
    secs.forEach(function (s) {
      var n = (s.querySelector('.ex-n') || {}).textContent || '', t = s.querySelector('.ex-head h2').textContent;
      var a = document.createElement('a'); a.href = '#' + s.id; a.dataset.s = s.id; a.setAttribute('aria-label', n + ' ' + t);
      a.innerHTML = '<i class="ex-tk"></i><span class="ex-tip"><b></b></span>';
      a.querySelector('b').textContent = n; a.querySelector('.ex-tip').appendChild(document.createTextNode(t));
      rail.appendChild(a);
    });
    var links = [].slice.call(rail.querySelectorAll('a')), lock = null, raf = 0;
    function set(id) { links.forEach(function (l) { l.classList.toggle('ex-on', l.dataset.s === id); }); }
    function pick() {
      raf = 0; if (lock || !secs.length) return;
      var line = innerHeight * .35, id = secs[0].id;
      secs.forEach(function (s) { if (s.getBoundingClientRect().top <= line) id = s.id; });
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) id = secs[secs.length - 1].id;
      set(id);
    }
    addEventListener('scroll', function () { if (!raf) raf = requestAnimationFrame(pick); }, { passive: true });
    addEventListener('resize', pick);
    links.forEach(function (a) { a.addEventListener('click', function () { set(a.dataset.s); clearTimeout(lock); lock = setTimeout(function () { lock = null; pick(); }, 900); }); });
    pick();
  }
})();
