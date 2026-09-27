// 홈 검색·필터: /data/index.json 을 받아 브라우저 안에서만 거른다
(function () {
  var $ = function (i) { return document.getElementById(i); }, D = null, n = 50;
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  function dday(d) { var k = Math.round((Date.parse(d) - Date.parse(today)) / 864e5); return k < 0 ? '마감' : k === 0 ? 'D-day' : 'D-' + k; }
  function sggs() {
    var sd = $('sd').value, seen = {}, out = [];
    if (D && sd !== '') D.d.forEach(function (x) { if (String(x[4]) === sd && x[5] && !seen[x[5]]) { seen[x[5]] = 1; out.push(x[5]); } });
    out.sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    $('sg').innerHTML = '<option value="">전체</option>' + out.map(function (g) { return '<option>' + h(g) + '</option>'; }).join('');
  }
  function active() { return ['q', 'tg', 'ag', 'sd', 'fd', 'ic'].some(function (i) { return $(i).value.trim() !== ''; }) || $('on').checked; }
  function draw() {
    if (!D) return;
    if (!active()) { $('sum').textContent = ''; $('list').innerHTML = ''; $('more').hidden = true; return; }
    var q = $('q').value.trim().toLowerCase().split(/\s+/).filter(Boolean), tg = $('tg').value, ag = $('ag').value, sd = $('sd').value, sg = $('sg').value,
      fd = $('fd').value, ic = $('ic').value, nat = $('nat').checked, on = $('on').checked;
    var L = D.d.filter(function (x) {
      if (tg !== '' && !(x[6] & (1 << tg))) return false;
      if (ag !== '' && ((x[11] != null && +ag < x[11]) || (x[12] != null && +ag > x[12]))) return false;
      if (sd !== '' && !(String(x[4]) === sd && (!sg || x[5] === sg)) && !(nat && x[4] === -1)) return false;
      if (fd !== '' && String(x[3]) !== fd) return false;
      if (ic !== '' && x[7] && !(x[7] & (1 << ic))) return false;
      if (on && !x[8]) return false;
      var t = (x[1] + ' ' + x[2] + ' ' + x[10]).toLowerCase();
      return q.every(function (w) { return t.indexOf(w) >= 0; });
    });
    $('sum').textContent = L.length.toLocaleString() + '개 서비스';
    $('list').innerHTML = L.slice(0, n).map(function (x) {
      return '<li><a href="/s/' + h(x[0]) + '/">' + h(x[1]) + '</a> <span class="hint">' + h(x[2]) + ' · ' + h(D.f[x[3]]) +
        (x[9] ? ' · ~' + x[9].slice(5).replace('-', '.') + ' <b>' + dday(x[9]) + '</b>' : '') + '</span>' + (x[10] ? '<br><span class="sm">' + h(x[10]) + '</span>' : '') + '</li>';
    }).join('');
    $('more').hidden = L.length <= n;
  }
  function reset() { n = 50; draw(); }
  ['q', 'ag'].forEach(function (i) { $(i).addEventListener('input', reset); });
  ['tg', 'sg', 'fd', 'ic', 'nat', 'on'].forEach(function (i) { $(i).addEventListener('change', reset); });
  $('sd').addEventListener('change', function () { sggs(); reset(); });
  $('more').onclick = function () { n += 50; draw(); };
  fetch('/data/index.json').then(function (r) { return r.json(); }).then(function (j) { D = j; sggs(); draw(); })
    .catch(function () { $('sum').textContent = '목록을 불러오지 못했어요. 새로고침해 주세요.'; });
})();
