(function () {
  'use strict';
  var D = null; var view = 'apps'; var sel = '';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function apps() {
    var map = {};
    D.routes.forEach(function (r) { (r.calledBy || []).forEach(function (a) { (map[a] = map[a] || []).push(r); }); });
    D.collections.forEach(function (c) { (c.websiteFiles || []).forEach(function (f) { var a = appOf(f); map[a] = map[a] || []; }); });
    return map;
  }
  function appOf(f) {
    if (f.indexOf('src/') === 0) return 'Coaching Software'; if (f.indexOf('public/athlete-app/') === 0) return 'Athlete App';
    if (f.indexOf('public/coach-app/') === 0) return 'Coach Pool Console / Assistant'; if (f.indexOf('public/stopwatch/') === 0) return 'Stopwatch';
    if (f.indexOf('public/video') === 0) return 'Video Analysis'; if (/^public\/(education|cpd)/.test(f)) return 'Education'; return 'Public website';
  }
  function items() {
    var q = $('q').value.trim().toLowerCase(); var out = [];
    if (view === 'apps') out = Object.keys(apps()).sort();
    if (view === 'collections') out = D.collections.map(function (c) { return c.name; });
    if (view === 'routes') out = D.routes.map(function (r) { return r.method + ' ' + r.path; });
    if (view === 'relationships') out = D.relationships.map(function (r) { return r.field + ' → ' + r.references; });
    if (view === 'integrations') out = D.integrations.map(function (i) { return i.name; });
    if (view === 'storage') out = D.storage.map(function (s) { return s.name; });
    return out.filter(function (x) { return !q || x.toLowerCase().indexOf(q) >= 0; });
  }
  function renderList() {
    $('items').innerHTML = items().map(function (x) { return '<div class="item' + (x === sel ? ' sel' : '') + '" role="button" tabindex="0" data-k="' + esc(x) + '">' + esc(x) + '</div>'; }).join('') || '<p class="muted">Nothing matches.</p>';
  }
  function routeLine(r) { return '<li><a class="link" data-go="routes" data-k="' + esc(r.method + ' ' + r.path) + '"><code>' + esc(r.method + ' ' + r.path) + '</code></a> <span class="tag">' + esc(r.permission) + '</span></li>'; }
  function collLink(n) { return '<a class="link" data-go="collections" data-k="' + esc(n) + '">' + esc(n) + '</a>'; }
  function detail(k) {
    var h = '';
    if (view === 'apps') {
      var rs = apps()[k] || [];
      var cs = D.collections.filter(function (c) { return (c.websiteFiles || []).some(function (f) { return appOf(f) === k; }); });
      h = '<h2>' + esc(k) + '</h2><h3>Server routes it calls (' + rs.length + ')</h3><ul>' + rs.map(routeLine).join('') + '</ul>'
        + '<h3>Club data it reads or edits (' + cs.length + ')</h3><p>' + (cs.map(function (c) { return collLink(c.name); }).join(', ') || '<span class="muted">none detected</span>') + '</p>'
        + '<p class="muted">Detected from the app\'s source files. Club records edited in the Coaching Software are saved through <code>/db</code> (whole-club save with server-side protections).</p>';
    }
    if (view === 'collections') {
      var c = D.collections.filter(function (x) { return x.name === k; })[0];
      var rels = D.relationships.filter(function (r) { return r.references === k; });
      h = '<h2>' + esc(k) + '</h2><p class="muted">Stored as a list of records in each club\'s <code>tenants/&lt;club&gt;/db.json</code>.</p>'
        + '<h3>Referenced by</h3><ul>' + (rels.map(function (r) { return '<li><code>' + esc(r.field) + '</code> <span class="tag ' + (/enforced/.test(r.kind) ? 'ok' : 'warn') + '">' + esc(r.kind) + '</span></li>'; }).join('') || '<li class="muted">no *Id field reference detected</li>') + '</ul>'
        + '<h3>Server code using it</h3><ul>' + (c.usedIn.map(function (f) { return '<li><code>' + esc(f) + '</code>' + (c.writtenIn.indexOf(f) >= 0 ? ' <span class="tag">writes</span>' : '') + '</li>'; }).join('') || '<li class="muted">handled generically by the whole-club load/save</li>') + '</ul>'
        + '<h3>App screens using it</h3><ul>' + ((c.websiteFiles || []).map(function (f) { return '<li><code>' + esc(f) + '</code> <span class="tag">' + esc(appOf(f)) + '</span></li>'; }).join('') || '<li class="muted">none detected</li>') + '</ul>';
    }
    if (view === 'routes') {
      var r = D.routes.filter(function (x) { return x.method + ' ' + x.path === k; })[0];
      h = '<h2><code>' + esc(k) + '</code></h2><p>Area: ' + esc(r.area) + '</p><p>Permission: <strong>' + esc(r.permission) + '</strong></p>'
        + '<p>Guards: ' + (r.guards.map(function (g) { return '<code>' + esc(g) + '</code>'; }).join(', ') || '<span class="muted">none</span>') + '</p>'
        + '<p>Defined in <code>' + esc(r.file) + ':' + r.line + '</code></p><h3>Called by</h3><p>' + (r.calledBy.map(esc).join(', ') || '<span class="muted">no caller detected in the website (may be called by other apps or tests)</span>') + '</p>';
    }
    if (view === 'relationships') {
      var rel = D.relationships.filter(function (x) { return x.field + ' → ' + x.references === k; })[0];
      h = '<h2>' + esc(k) + '</h2><p class="' + (/enforced/.test(rel.kind) ? 'ok' : 'warn') + '">' + esc(rel.kind) + '</p><h3>Files</h3><ul>' + rel.files.map(function (f) { return '<li><code>' + esc(f) + '</code></li>'; }).join('') + '</ul>'
        + (D.collections.some(function (c) { return c.name === rel.references; }) ? '<p>Target: ' + collLink(rel.references) + '</p>' : '');
    }
    if (view === 'integrations') {
      var i = D.integrations.filter(function (x) { return x.name === k; })[0];
      h = '<h2>' + esc(k) + '</h2><h3>Configuration names (values are never shown)</h3><ul>' + i.env.map(function (e) { return '<li><code>' + esc(e) + '</code></li>'; }).join('') + '</ul>';
    }
    if (view === 'storage') { var s = D.storage.filter(function (x) { return x.name === k; })[0]; h = '<h2><code>' + esc(k) + '</code></h2><p>' + esc(s.description) + '</p>'; }
    $('detail').innerHTML = h;
  }
  function go(v, k) {
    view = v; sel = k || '';
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    $('q').value = ''; renderList(); if (sel) detail(sel); else $('detail').innerHTML = '<p class="muted">Select an item to see what it does and how it connects.</p>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('nav button'); if (b) { go(b.getAttribute('data-view')); return; }
    var a = e.target.closest('[data-go]'); if (a) { go(a.getAttribute('data-go'), a.getAttribute('data-k')); return; }
    var it = e.target.closest('.item'); if (it) { sel = it.getAttribute('data-k'); renderList(); detail(sel); }
  });
  document.addEventListener('keydown', function (e) { var it = e.target.closest && e.target.closest('.item'); if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); it.click(); } });
  $('q').addEventListener('input', renderList);
  fetch('system-map/data.json', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('Owner access required.'); return r.json(); }).then(function (d) {
    D = d; $('meta').textContent = d.note + ' ' + d.routes.length + ' routes, ' + d.collections.length + ' data collections.'; go('apps');
  }).catch(function (e) { $('meta').textContent = e.message; });
})();
