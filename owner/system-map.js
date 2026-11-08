(function () {
  'use strict';
  var D = null; var view = 'modules'; var sel = ''; var tab = 'overview'; var q = '';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var B = { confirmed: '<span class="badge confirmed">confirmed in code</span>', inferred: '<span class="badge inferred">inferred</span>', conceptual: '<span class="badge conceptual">conceptual</span>' };
  var GROUPS = ['Coaching', 'Poolside', 'Evidence', 'Assessment', 'Athlete', 'Identity', 'Products', 'Commercial', 'Integrations'];
  var mod = function (id) { return D.modules.filter(function (m) { return m.id === id; })[0]; };
  var tbl = function (n) { return D.collections.filter(function (c) { return c.name === n; })[0]; };
  var link = function (type, key, label) { return '<button class="clickable" data-go="' + type + '" data-k="' + esc(key) + '">' + esc(label || key) + '</button>'; };
  var fields = function (list) { return '<div class="fieldlist">' + (list || []).map(function (f) { return '<code>' + esc(f) + '</code>'; }).join('') + '</div>'; };
  function hay(x) { return JSON.stringify(x).toLowerCase(); }
  function formsForModule(m) {
    var cols = (m.code && m.code.collections) || []; var apps = (m.code && m.code.apps) || [];
    return D.forms.filter(function (f) { return f.likelyTables.some(function (t) { return cols.indexOf(t.name) >= 0; }) || (apps.indexOf(f.app) >= 0 && !f.likelyTables.length && cols.length === 0); });
  }
  function modulesForTable(n) { return D.modules.filter(function (m) { return m.code && m.code.collections.indexOf(n) >= 0; }); }

  function list() {
    var out = '';
    if (view === 'modules') {
      $('listTitle').textContent = 'Modules and data flow'; $('listHint').textContent = 'Choose a module to see its forms, tables, data flow, permissions and connections.';
      out = GROUPS.map(function (g) {
        var items = D.modules.filter(function (m) { return m.group === g && (!q || hay(m).indexOf(q) >= 0); });
        return items.length ? '<div class="grouphead">' + esc(g) + '</div><div class="flowgrid">' + items.map(function (m) { return '<button class="node ' + (sel === m.id ? 'sel' : '') + '" data-go="module" data-k="' + m.id + '"><strong>' + esc(m.title) + '</strong><em>' + esc(m.status) + '</em></button>'; }).join('') + '</div>' : '';
      }).join('');
    }
    if (view === 'tables') {
      $('listTitle').textContent = 'Data tables'; $('listHint').textContent = 'Each club stores these collections in its own data file. Click a table for its fields and connections.';
      out = '<div class="flowgrid">' + D.collections.filter(function (c) { return !q || hay(c).indexOf(q) >= 0; }).map(function (c) { return '<button class="node ' + (sel === c.name ? 'sel' : '') + '" data-go="table" data-k="' + esc(c.name) + '"><strong>' + esc(c.name) + '</strong><em>' + (c.fields.length ? c.fields.length + ' fields' : 'fields set by forms') + '</em></button>'; }).join('') + '</div>';
    }
    if (view === 'forms') {
      $('listTitle').textContent = 'Forms found in code'; $('listHint').textContent = 'Forms detected from their form state or input elements. Click one for its fields and the tables it likely writes to.';
      out = '<div class="flowgrid">' + D.forms.map(function (f, i) { return [f, i]; }).filter(function (x) { return !q || hay(x[0]).indexOf(q) >= 0; }).map(function (x) { var f = x[0]; return '<button class="node ' + (sel === String(x[1]) ? 'sel' : '') + '" data-go="form" data-k="' + x[1] + '"><strong>' + esc(f.name) + '</strong><em>' + esc(f.app) + ' · ' + f.fields.length + ' fields</em></button>'; }).join('') + '</div>';
    }
    if (view === 'engine') { $('listTitle').textContent = 'Canonical capability engine'; $('listHint').textContent = ''; out = engineHtml(); }
    if (view === 'routes') {
      $('listTitle').textContent = 'Server routes and permissions'; $('listHint').textContent = 'GET reads data; POST/PUT/DELETE writes. Permission is enforced on the server.';
      out = D.routes.filter(function (r) { return !q || hay(r).indexOf(q) >= 0; }).map(function (r) { return '<div class="item">' + link('route', r.method + ' ' + r.path, r.method + ' ' + r.path) + '<span>' + esc(r.permission) + '</span></div>'; }).join('');
    }
    if (view === 'external') { $('listTitle').textContent = 'External services'; $('listHint').textContent = 'Setting names only; values are never shown.'; out = D.integrations.map(function (i) { return '<div class="item"><b>' + esc(i.name) + '</b>' + fields(i.env) + '</div>'; }).join(''); }
    $('flow').innerHTML = out || '<p>Nothing matches.</p>';
    nav();
  }
  function engineHtml() {
    var e = D.engine;
    return '<p>' + esc(e.note) + '</p><h3>Eight capabilities</h3><ol>' + e.axes.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ol>'
      + '<h3>Four capability profiles</h3>' + e.profiles.map(function (p) { return '<div class="item"><b>' + esc(p.name) + '</b><span>' + esc(p.from) + '</span><span>Data: ' + p.collections.map(function (c) { return tbl(c) ? link('table', c) : esc(c); }).join(', ') + '</span></div>'; }).join('')
      + '<p class="path"><strong>Session planning</strong><span class="arrow">→</span><strong>Attendance and recorded results</strong><span class="arrow">→</span><strong>Training profile</strong><span class="arrow">→</span><strong>Integrated profile</strong><span class="arrow">→</span><strong>ISP report</strong></p>'
      + '<h3>Engine source files ' + B.confirmed + '</h3>' + fields(e.files);
  }
  function nav() {
    $('navigation').innerHTML = GROUPS.map(function (g) {
      var items = D.modules.filter(function (m) { return m.group === g && (!q || hay(m).indexOf(q) >= 0); });
      return items.length ? '<div class="nav-title">' + esc(g) + '</div><div class="nav">' + items.map(function (m) { return '<button class="' + (view === 'modules' && sel === m.id ? 'on' : '') + '" data-go="module" data-k="' + m.id + '"><span class="dot ' + esc(m.group) + '"></span>' + esc(m.title) + '</button>'; }).join('') + '</div>' : '';
    }).join('');
  }
  function moduleDetail(m) {
    var c = m.code || {}; var linkIds = []; D.modules.forEach(function (o) { if (o.id !== m.id && ((m.links || []).indexOf(o.id) >= 0 || (o.links || []).indexOf(m.id) >= 0)) linkIds.push(o.id); });
    var tabs = ['overview', 'forms', 'data', 'flow', 'access', 'connections'];
    var h = '<div class="small">' + esc(m.group) + ' / ' + esc(m.status) + ' · ' + esc(m.source) + '</div><h2 style="margin-top:5px">' + esc(m.title) + '</h2><p>' + esc(m.desc) + '</p>'
      + '<div class="tabs">' + tabs.map(function (t) { return '<button data-tab="' + t + '" class="' + (tab === t ? 'on' : '') + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'; }).join('') + '</div>';
    if (tab === 'overview') h += '<p>Applications: ' + (c.apps || []).map(esc).join(', ') + '</p>' + (c.note ? '<p class="small">' + esc(c.note) + '</p>' : '') + (c.engine ? '<p>Uses the ' + '<button class="clickable" data-view="engine">canonical capability engine</button>.</p>' : '') + '<p>Storage: ' + ((c.store || []).concat(c.collections.length ? ['club data file'] : [])).map(esc).join(', ') + '</p>';
    if (tab === 'forms') {
      h += '<h3>Forms (owner map) ' + B.conceptual + '</h3>' + (m.forms || []).map(function (f) { return '<div class="item"><b>' + esc(f.name) + '</b><span>' + esc(f.fields) + '</span><span class="small">' + esc(f.note) + '</span></div>'; }).join('');
      var fs = formsForModule(m);
      h += '<h3>Forms found in code ' + B.confirmed + '</h3>' + (fs.map(function (f) { return '<div class="item">' + link('form', String(D.forms.indexOf(f)), f.name + ' (' + f.app + ')') + '<span>' + f.fields.length + ' fields · ' + esc(f.file) + '</span></div>'; }).join('') || '<p class="small">No separate form state detected; edits are made in the module\'s screens and saved with the whole club.</p>');
    }
    if (tab === 'data') {
      h += '<h3>Tables in code ' + B.confirmed + '</h3>' + (c.collections.map(function (n) { var t = tbl(n); return '<div class="item">' + link('table', n) + '<span>' + (t && t.fields.length ? t.fields.length + ' fields' : '') + '</span></div>'; }).join('') || '<p class="small">No club collection.</p>')
        + '<h3>Data groups (owner map) ' + B.conceptual + '</h3>' + fields(m.tables);
    }
    if (tab === 'flow') {
      h += '<h3>Reads (server → app) ' + B.confirmed + '</h3>' + (c.reads.map(function (r) { return '<div class="flowline">' + esc(c.apps[0] || 'App') + '<span class="arrow">←</span>' + link('route', r) + '</div>'; }).join('') || '<p class="small">None.</p>')
        + '<h3>Writes (app → server) ' + B.confirmed + '</h3>' + (c.writes.map(function (r) { return '<div class="flowline">' + esc(c.apps[0] || 'App') + '<span class="arrow">→</span>' + link('route', r) + '</div>'; }).join('') || '<p class="small">None of its own.</p>')
        + (c.collections.length ? '<p class="small">Coaching Software screens also save these tables through the whole-club save (<code>PUT /db</code>), which keeps server-owned fields.</p>' : '');
    }
    if (tab === 'access') h += '<h3>Permissions ' + B.confirmed + '</h3><ul>' + (c.permissions.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') || '<li>No server routes.</li>') + '</ul>' + ((c.integrations || []).length ? '<h3>External services</h3><p>' + c.integrations.map(esc).join(', ') + '</p>' : '');
    if (tab === 'connections') h += '<h3>Functional connections ' + B.conceptual + '</h3><div class="rail">' + linkIds.map(function (id) { return '<button class="link" data-go="module" data-k="' + id + '">' + esc(mod(id).title) + '</button>'; }).join('') + '</div>'
      + '<h3>Data relationships</h3>' + (D.relationships.filter(function (r) { return c.collections.indexOf(r.references) >= 0; }).map(function (r) { return '<div class="flowline"><code>' + esc(r.field) + '</code><span class="arrow">→</span>' + link('table', r.references) + (/enforced/.test(r.kind) ? B.confirmed : B.inferred) + '</div>'; }).join('') || '<p class="small">None detected.</p>');
    return h;
  }
  function tableDetail(t) {
    var rels = D.relationships.filter(function (r) { return r.references === t.name; });
    var fs = D.forms.filter(function (f) { return f.likelyTables.some(function (x) { return x.name === t.name; }); });
    return '<div class="small">Club collection · tenants/&lt;club&gt;/db.json</div><h2 style="margin-top:5px">' + esc(t.name) + '</h2>'
      + '<h3>Fields ' + (t.fields.length ? B.confirmed : '') + '</h3>' + (t.fields.length ? fields(t.fields) : '<p class="small">' + esc(t.fieldsSource) + '</p>')
      + Object.keys(t.nestedFields || {}).map(function (k) { return '<p class="small">Inside <code>' + esc(k) + '</code>:</p>' + fields(t.nestedFields[k]); }).join('')
      + (t.fields.length ? '<p class="small">Field source: ' + esc(t.fieldsSource) + '</p>' : '')
      + '<h3>Referenced by</h3>' + (rels.map(function (r) { return '<div class="flowline"><code>' + esc(r.field) + '</code> ' + (/enforced/.test(r.kind) ? B.confirmed : B.inferred) + ' <span class="small">' + esc(r.kind) + '</span></div>'; }).join('') || '<p class="small">No *Id reference detected.</p>')
      + '<h3>Modules</h3><p>' + (modulesForTable(t.name).map(function (m) { return link('module', m.id, m.title); }).join(', ') || '—') + '</p>'
      + '<h3>Forms that likely write it ' + B.inferred + '</h3>' + (fs.map(function (f) { var s = f.likelyTables.filter(function (x) { return x.name === t.name; })[0]; return '<div class="item">' + link('form', String(D.forms.indexOf(f)), f.name + ' (' + f.app + ')') + '<span>shared fields: ' + esc(s.shared.join(', ')) + '</span></div>'; }).join('') || '<p class="small">None detected.</p>')
      + '<h3>Server code ' + B.confirmed + '</h3>' + fields((t.usedIn || []).map(function (f) { return f + ((t.writtenIn || []).indexOf(f) >= 0 ? ' (writes)' : ''); }))
      + '<h3>App screens ' + B.confirmed + '</h3>' + fields(t.websiteFiles || []);
  }
  function formDetail(f) {
    return '<div class="small">' + esc(f.app) + ' · detected from ' + esc(f.source) + '</div><h2 style="margin-top:5px">' + esc(f.name) + '</h2><p><code>' + esc(f.file) + '</code></p>'
      + '<h3>Fields ' + B.confirmed + '</h3>' + fields(f.fields)
      + '<h3>Likely saved to ' + B.inferred + '</h3>' + (f.likelyTables.map(function (t) { return '<div class="flowline">' + esc(f.name) + '<span class="arrow">→</span>' + link('table', t.name) + ' <span class="small">shared fields: ' + esc(t.shared.join(', ')) + '</span></div>'; }).join('') || '<p class="small">No table shares enough fields (personal, temporary or settings form).</p>');
  }
  function routeDetail(k) {
    var r = D.routes.filter(function (x) { return x.method + ' ' + x.path === k; })[0]; if (!r) return '';
    var ms = D.modules.filter(function (m) { return m.code && (m.code.reads.indexOf(k) >= 0 || m.code.writes.indexOf(k) >= 0); });
    return '<div class="small">' + esc(r.area) + '</div><h2 style="margin-top:5px"><code>' + esc(k) + '</code></h2><p>' + (r.method === 'GET' ? 'Reads data (server → app)' : 'Changes data (app → server)') + '</p>'
      + '<p>Permission: <b>' + esc(r.permission) + '</b> ' + B.confirmed + '</p><p class="small">Defined in ' + esc(r.file) + ':' + r.line + '</p>'
      + '<h3>Called by</h3><p>' + (r.calledBy.map(esc).join(', ') || '<span class="small">No caller found in the website code.</span>') + '</p><h3>Modules</h3><p>' + ms.map(function (m) { return link('module', m.id, m.title); }).join(', ') + '</p>';
  }
  function show(type, k) {
    var h = '';
    if (type === 'module') { view = 'modules'; sel = k; h = moduleDetail(mod(k)); }
    if (type === 'table') { view = 'tables'; sel = k; h = tableDetail(tbl(k)); }
    if (type === 'form') { view = 'forms'; sel = k; h = formDetail(D.forms[Number(k)]); }
    if (type === 'route') { view = 'routes'; sel = k; h = routeDetail(k); }
    setViewButtons(); list(); $('detail').innerHTML = h;
  }
  function setViewButtons() { Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) { b.classList.toggle('active', b.getAttribute('data-view') === view); }); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]'); if (t) { tab = t.getAttribute('data-tab'); $('detail').innerHTML = moduleDetail(mod(sel)); return; }
    var v = e.target.closest('[data-view]'); if (v) { view = v.getAttribute('data-view'); sel = ''; setViewButtons(); list(); $('detail').innerHTML = view === 'engine' ? '' : '<h2>Select an item</h2><p class="small">Choose an item on the left to see its details and connections.</p>'; if (view === 'engine') $('detail').innerHTML = '<h2>Four profiles, one engine</h2><p>Training, Testing and Competition evidence is assessed on the same eight capabilities and combined into the Integrated profile with evidence sufficiency and confidence.</p>'; return; }
    var g = e.target.closest('[data-go]'); if (g) { if (g.getAttribute('data-go') === 'module') tab = 'overview'; show(g.getAttribute('data-go'), g.getAttribute('data-k')); }
  });
  $('search').addEventListener('input', function (e) { q = e.target.value.trim().toLowerCase(); list(); });
  $('print').addEventListener('click', function () { window.print(); });
  fetch('system-map/data.json', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('Owner access required.'); return r.json(); }).then(function (d) {
    D = d;
    $('cModules').textContent = d.modules.length; $('cTables').textContent = d.collections.length; $('cForms').textContent = d.forms.length; $('cRoutes').textContent = d.routes.length;
    $('scope').innerHTML = '<b>Scope:</b> ' + esc(d.note) + ' Badges show what is <span class="badge confirmed">confirmed in code</span>, <span class="badge inferred">inferred</span> from code, or <span class="badge conceptual">conceptual</span> from the owner map. Read-only; it does not connect to production data.';
    show('module', 'swimmer');
  }).catch(function (e) { $('scope').textContent = e.message; });
})();
