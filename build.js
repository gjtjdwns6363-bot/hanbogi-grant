#!/usr/bin/env node
// 정부 지원금 찾기 정적 사이트 생성기. 의존성 없음 (Node 20+ fetch).
//   node build.js             — 공공데이터포털 API 호출 (env DATA_GO_KR_KEY = 디코딩 키)
//   node build.js --fixtures  — fixtures/ 의 저장된 응답으로 생성 (키 불필요)
// 종료 코드: 0 성공, 3 인증 실패(키 미승인·무효 → 워크플로가 배포를 건너뜀), 1 그 밖의 실패
'use strict';
const fs = require('fs');
const path = require('path');

const FIX = process.argv.includes('--fixtures');
const SITE = 'https://grant.hanbogi.com';
const CALC = 'https://calc.hanbogi.com';
const BENEFIT = 'https://benefit.hanbogi.com';
const API = 'https://api.odcloud.kr/api/gov24/v3';
const OUT = path.join(__dirname, 'dist');
const PER_PAGE = +process.env.PER_PAGE || 1000;
const MIN_LIVE = 1000; // 실제 호출인데 서비스가 이보다 적으면 빈 사이트 배포를 막으려고 실패 처리
const SITEMAP_MAX = 5000;
const DAY = 86400e3;

// ---------- 순수 함수 (test.js에서 검사) ----------
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (s) => esc(String(s ?? '').trim()).replace(/\r?\n/g, '<br>');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const normDate = (s) => { // "20260927151208" | "2026-09-27" → "2026-09-27"
  const d = String(s ?? '').replace(/\D/g, '').slice(0, 8);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '';
};
const slug = (s) => String(s).trim().replace(/[\s·/]+/g, '-');

// 신청기한 → 마지막 날짜 "YYYY-MM-DD" (없으면 ''). "2026. 3. 1. ~ 10. 31." 처럼 끝 날짜에 연도가 없으면 앞 연도를 쓴다.
function parseDeadline(s) {
  s = String(s ?? '');
  const re = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?!\d)/g;
  let last = null, m;
  while ((m = re.exec(s))) last = { y: +m[1], mo: +m[2], d: +m[3], end: re.lastIndex };
  if (!last) return '';
  const tail = s.slice(last.end).match(/^\s*일?\.?\s*[~∼-]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})(?!\d)/);
  if (tail) { last.mo = +tail[1]; last.d = +tail[2]; }
  const { y, mo, d } = last;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return dt.toISOString().slice(0, 10);
}

const SIDOS = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시', '경기도', '강원특별자치도',
  '충청북도', '충청남도', '전북특별자치도', '전라남도', '전남광주통합특별시', '경상북도', '경상남도', '제주특별자치도'];
const SIDO_ALIAS = { 강원도: '강원특별자치도', 전라북도: '전북특별자치도' };
// 소관기관명 → { sido, sgg }. 중앙부처·공공기관은 sido '' (전국). "경기도 수원시 장안구" → 수원시 장안구
function regionOf(org) {
  org = String(org ?? '').trim();
  const names = [...SIDOS, ...Object.keys(SIDO_ALIAS)].sort((a, b) => b.length - a.length);
  const hit = names.find((n) => org.startsWith(n));
  if (!hit) return { sido: '', sgg: '' };
  const toks = org.slice(hit.length).trim().split(/\s+/);
  let sgg = '';
  if (/^\S+[시군구]$/.test(toks[0] || '')) sgg = toks[0] + (/^\S+시$/.test(toks[0]) && /^\S+구$/.test(toks[1] || '') ? ' ' + toks[1] : '');
  return { sido: SIDO_ALIAS[hit] || hit, sgg };
}

// 대상 분류(신혼부부·임산부·중소기업 …)는 targets.js 한 곳에 모아 둔다
const { TARGETS, GROUPS, targetsOf } = require('./targets.js');
const tPath = (t) => `/t/${t.slug}/`;
const TBY = new Map(TARGETS.map((t) => [t.label, t]));
const TARGET_MIN = 3; // 랜딩 페이지는 이 개수 미만이거나 색인할 서비스가 없으면 noindex
const targetNoindex = (l) => l.length < TARGET_MIN || !l.some((s) => s.indexable);
// 대상 랜딩 정렬: 마감 임박(오늘 이후 마감이 가까운 순) → 나머지는 최근 수정 순
const urgentFirst = (today) => (a, b) => {
  const ua = !!a.deadline && a.deadline >= today, ub = !!b.deadline && b.deadline >= today;
  if (ua !== ub) return ua ? -1 : 1;
  return ua ? a.deadline.localeCompare(b.deadline) : String(b.수정일시 || '').localeCompare(String(a.수정일시 || ''));
};
const INCOME = ['중위소득 50% 이하', '51~75%', '76~100%', '101~200%', '200% 초과'];
const incomeMask = (c) => ['JA0201', 'JA0202', 'JA0203', 'JA0204', 'JA0205'].reduce((m, k, i) => m | (c?.[k] === 'Y' ? 1 << i : 0), 0);
const isOnline = (s) => /^https?:\/\//.test(s.온라인신청사이트URL || '') || /온라인|인터넷/.test(s.신청방법 || '');

// 색인 기준: 지원대상·선정기준·지원내용 합쳐 글자 40자 이상, 지원내용 10자 이상
const letters = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').length;
const isMeaningful = (s) => letters(s.지원내용) >= 10 && letters(`${s.지원대상}${s.선정기준}${s.지원내용}`) >= 40;

function sitemaps(paths, today, max = SITEMAP_MAX) { // → { 파일명: 내용 }. max 초과면 sitemap-N.xml + 색인
  const urlset = (ps) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${ps.map((p) => `<url><loc>${esc(SITE + encodeURI(p))}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  if (paths.length <= max) return { 'sitemap.xml': urlset(paths) };
  const out = {};
  for (let i = 0; i * max < paths.length; i++) out[`sitemap-${i + 1}.xml`] = urlset(paths.slice(i * max, (i + 1) * max));
  out['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(out).map((f) => `<sitemap><loc>${SITE}/${f}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`;
  return out;
}

const CALCS = [
  [/근로장려|자녀장려/, 'eitc', '근로장려금·자녀장려금 계산기'],
  [/육아휴직|출산전후휴가|육아기/, 'parental-leave', '육아휴직 급여 계산기'],
  [/구직급여|실업급여|조기재취업/, 'unemployment', '실업급여 계산기'],
];
function calcLinks(s) {
  const t = `${s.서비스명} ${s.지원내용}`, out = CALCS.filter(([re]) => re.test(t)).map(([, p, n]) => [p, n]);
  if (s.서비스분야 === '고용·창업') out.push(['salary', '연봉 실수령액 계산기'], ['hourly', '알바 시급·주휴수당 계산기']);
  return out;
}

// ---------- 호출 ----------
const enc = encodeURIComponent(process.env.DATA_GO_KR_KEY || '');
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fatal = (msg, auth) => Object.assign(new Error(msg), { fatal: true, auth });
async function get(url, label) { // 오류 메시지에 URL(키 포함)을 절대 넣지 않는다
  for (let i = 0; ; i++) {
    await sleep(250); // ponytail: 순차 호출 + 고정 간격, 수십 회라 충분
    calls++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const body = await r.text();
      if (r.status === 401 || r.status === 403 || /"code"\s*:\s*-(4|401)\b/.test(body)) throw fatal(`${label}: 인증 실패 HTTP ${r.status} ${body.slice(0, 200)}`, true);
      if (r.status === 429) throw fatal(`${label}: 호출 한도 초과 ${body.slice(0, 200)}`);
      if (!r.ok) throw new Error(`${label}: HTTP ${r.status} ${body.slice(0, 200)}`);
      return body;
    } catch (e) {
      if (e.fatal || i >= 3) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}
async function fetchAll(op) { // odcloud 페이지 순회 → data 배열
  if (FIX) return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', op + '.json'), 'utf8')).data;
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const body = await get(`${API}/${op}?serviceKey=${enc}&page=${page}&perPage=${PER_PAGE}&returnType=JSON`, `${op} p${page}`);
    let j; try { j = JSON.parse(body); } catch { throw fatal(`${op}: JSON 아님 ${body.slice(0, 200)}`); }
    if (!Array.isArray(j.data)) throw fatal(`${op}: 오류 ${j.code} ${j.msg}`);
    out.push(...j.data);
    console.log(`[진행] ${op} ${out.length}/${j.totalCount}`);
    if (!j.data.length || out.length >= (j.matchCount ?? j.totalCount ?? 0)) break;
  }
  return out;
}

// ---------- 렌더 ----------
let STAMP = '';
function page({ title, desc, p, body, noindex, ld }) {
  const url = SITE + encodeURI(p);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">${noindex ? '\n<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5424435978828190" crossorigin="anonymous"></script>
<meta name="naver-site-verification" content="b1be46046dc6d5116c831e7ca56190a9c8a6067a" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-19F8RF6971"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-19F8RF6971");</script>${ld ? `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<header><a href="/">정부 지원금 찾기</a></header>
<main>
${body}
<p class="warn">⚠️ 참고용 정보예요. 공공데이터(보조금24)를 매일 옮겨 온 것이라 늦게 반영되거나 바뀔 수 있어요. <b>공식 정보는 보조금24·소관기관에서 최종 확인</b>하세요.</p>
<div class="card"><b>📌 함께 보면 좋은 곳</b>
<ul class="chips" style="margin:10px 0 0"><li><a href="${BENEFIT}/">혜택 알리미 블로그</a></li><li><a href="${CALC}/eitc/">근로장려금 계산기</a></li><li><a href="${CALC}/parental-leave/">육아휴직 급여 계산기</a></li><li><a href="${CALC}/unemployment/">실업급여 계산기</a></li><li><a href="${CALC}/">한눈 계산기</a></li></ul></div>
</main>
<footer>데이터 출처: 행정안전부 대한민국 공공서비스(혜택) 정보 (공공데이터포털), 기준 시각 ${STAMP} KST<br>
© 정부 지원금 찾기 · <a href="/">홈</a> · <a href="/t/">대상별</a> · <a href="/c/">분야별</a> · <a href="/r/">지역별</a> · <a href="/privacy.html">개인정보처리방침</a></footer>
</body></html>
`;
}
const href = (p) => esc(encodeURI(p));
const svcPath = (s) => `/s/${s.서비스ID}/`;
const ddayLabel = (d, today) => { if (!d) return ''; const n = Math.round((Date.parse(d) - Date.parse(today)) / DAY); return n < 0 ? '마감' : n === 0 ? 'D-day' : `D-${n}`; };
function svcList(list, today, max = Infinity, attr = () => '') {
  if (!list.length) return '<p class="hint">해당 서비스가 없어요.</p>';
  return '<ul class="svc">' + list.slice(0, max).map((s) => `<li${attr(s)}><a href="${href(svcPath(s))}">${esc(s.서비스명)}</a>` +
    ` <span class="hint">${esc(s.소관기관명)}${s.deadline ? ` · ~${s.deadline.slice(5).replace('-', '.')} <b>${ddayLabel(s.deadline, today)}</b>` : ''}</span>` +
    (s.서비스목적요약 ? `<br><span class="sm">${esc(clip(s.서비스목적요약, 70))}</span>` : '') + '</li>').join('') + '</ul>';
}
const crumbs = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + encodeURI(p) })) });

function servicePage(s, today) {
  const rows = [
    ['지원 대상', s.지원대상], ['선정 기준', s.선정기준], ['지원 내용', s.지원내용], ['신청 방법', s.신청방법], ['신청 기한', s.신청기한],
    ['구비 서류', s.구비서류], ['공무원 확인 서류', s.공무원확인구비서류], ['본인 확인 필요 서류', s.본인확인필요구비서류],
    ['접수 기관', s.접수기관명 || s.접수기관], ['문의처', s.문의처 || s.전화문의], ['근거 법령', [s.법령, s.자치법규, s.행정규칙].filter(Boolean).join('\n')],
  ].filter(([, v]) => String(v ?? '').trim());
  const fieldP = s.서비스분야 ? `/c/${slug(s.서비스분야)}/` : '/c/';
  const regP = s.region.sido ? `/r/${slug(s.region.sido)}/${s.region.sgg ? slug(s.region.sgg) + '/' : ''}` : '';
  const online = /^https?:\/\//.test(s.온라인신청사이트URL || '') ? s.온라인신청사이트URL.trim() : '';
  const orig = /^https?:\/\//.test(s.상세조회URL || '') ? s.상세조회URL.trim() : `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${s.서비스ID}`;
  const calc = calcLinks(s);
  const body = `<p class="hint"><a href="/">홈</a> › <a href="${href(fieldP)}">${esc(s.서비스분야 || '분야')}</a>${regP ? ` › <a href="${href(regP)}">${esc([s.region.sido, s.region.sgg].filter(Boolean).join(' '))}</a>` : ''}</p>
<h1>${esc(s.서비스명)}</h1>
<p class="lead">${esc(s.소관기관명)}${s.부서명 ? ' ' + esc(s.부서명) : ''} · ${esc(s.지원유형 || '')}${s.deadline ? ` · 신청 마감 ${s.deadline} <b>${ddayLabel(s.deadline, today)}</b>` : ''}</p>
${s.서비스목적 || s.서비스목적요약 ? `<div class="card">${text(s.서비스목적 || s.서비스목적요약)}</div>` : ''}
${s.tags.length ? `<ul class="chips">${s.tags.map((t) => `<li><a href="${href(tPath(TBY.get(t)))}">${esc(t)} 지원금 모음</a></li>`).join('')}</ul>` : ''}
<p>${online ? `<a class="cta" href="${esc(online)}" rel="nofollow noopener" target="_blank">👉 온라인 신청하기</a> ` : ''}<a href="${esc(orig)}" rel="nofollow noopener" target="_blank">보조금24 원문 보기 →</a></p>
${rows.map(([k, v]) => `<h2>${k}</h2><div class="card">${text(v)}</div>`).join('\n')}
${calc.length ? `<p>미리 계산해 보기: ${calc.map(([p, n]) => `<a href="${CALC}/${p}/">${n}</a>`).join(' · ')}</p>` : ''}
<p class="src">서비스ID ${esc(s.서비스ID)} · 수정일 ${esc(normDate(s.수정일시) || '-')} · 등록일 ${esc(normDate(s.등록일시) || '-')}</p>`;
  return page({ title: `${s.서비스명} 신청 방법·지원 대상·금액 | 정부 지원금 찾기`, p: svcPath(s), body, noindex: !s.indexable,
    desc: clip(`${s.서비스명}(${s.소관기관명}): ${s.서비스목적요약 || s.지원내용 || ''} 지원 대상, 선정 기준, 신청 방법과 기한을 정리했어요.`, 155),
    ld: crumbs([['홈', '/'], [s.서비스분야 || '분야', fieldP], [s.서비스명, svcPath(s)]]) });
}

// ---------- 메인 ----------
async function main() {
  if (!FIX && !process.env.DATA_GO_KR_KEY) throw fatal('DATA_GO_KR_KEY 환경변수가 없어요 (fixture로 보려면 --fixtures)', true);
  const now = FIX ? new Date('2026-09-27T00:30:00Z') : new Date();
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const today = kst.toISOString().slice(0, 10);
  STAMP = kst.toISOString().slice(0, 16).replace('T', ' ');

  const list = await fetchAll('serviceList');
  const detail = new Map((await fetchAll('serviceDetail')).map((d) => [d.서비스ID, d]));
  const conds = new Map((await fetchAll('supportConditions')).map((c) => [c.서비스ID, c]));
  if (!FIX && list.length < MIN_LIVE) throw fatal(`서비스 목록이 너무 적어요 (${list.length}건) — 배포 안 함`);

  const seen = new Set();
  const svcs = list.filter((s) => /^[\w-]+$/.test(s.서비스ID || '') && !seen.has(s.서비스ID) && seen.add(s.서비스ID)).map((l) => {
    const d = detail.get(l.서비스ID) || {}, c = conds.get(l.서비스ID);
    const s = { ...l };
    for (const [k, v] of Object.entries(d)) if (String(v ?? '').trim()) s[k] = v; // 상세가 있으면 상세 우선
    s.region = regionOf(s.소관기관명);
    s.tags = targetsOf(s, c);
    s.inc = incomeMask(c);
    s.age = [c?.JA0110 ?? null, c?.JA0111 ?? null];
    s.online = isOnline(s);
    s.deadline = parseDeadline(s.신청기한);
    s.indexable = isMeaningful(s);
    return s;
  });

  // ---------- 쓰기 ----------
  fs.rmSync(OUT, { recursive: true, force: true });
  const indexable = [];
  let pages = 0;
  const write = (p, html) => { // 색인 여부는 페이지의 robots 메타로 판단
    const f = path.join(OUT, p.endsWith('/') ? p + 'index.html' : p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
    pages++;
    if (!html.includes('content="noindex')) indexable.push(p);
  };
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  for (const f of ['style.css', 'CNAME', 'home.js', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) fs.copyFileSync(path.join(__dirname, f), path.join(OUT, f));

  for (const s of svcs) write(svcPath(s), servicePage(s, today));

  const hasIdx = (s) => s.indexable; // 색인할 서비스가 하나도 없는 목록 페이지는 noindex
  // 분야
  const byField = new Map();
  for (const s of svcs) { const f = s.서비스분야 || '기타'; (byField.get(f) || byField.set(f, []).get(f)).push(s); }
  const fields = [...byField.keys()].sort((a, b) => byField.get(b).length - byField.get(a).length);
  const byViews = (a, b) => (+b.조회수 || 0) - (+a.조회수 || 0);
  for (const f of fields) {
    const l = byField.get(f).sort(byViews);
    const calc = calcLinks({ 서비스분야: f, 서비스명: '', 지원내용: '' });
    write(`/c/${slug(f)}/`, page({ title: `${f} 정부 지원금·혜택 ${comma(l.length)}개 | 정부 지원금 찾기`, p: `/c/${slug(f)}/`, noindex: !l.some(hasIdx),
      desc: `${f} 분야 정부·지자체 공공서비스 ${l.length}개의 지원 대상, 지원 내용, 신청 방법. 보조금24 자료로 매일 갱신.`,
      ld: crumbs([['홈', '/'], ['분야별', '/c/'], [f, `/c/${slug(f)}/`]]),
      body: `<p class="hint"><a href="/">홈</a> › <a href="/c/">분야별</a> › ${esc(f)}</p>
<h1>${esc(f)} 지원금·혜택 (${comma(l.length)}개)</h1>
<p class="lead">중앙부처·지자체·공공기관의 ${esc(f)} 분야 공공서비스예요. 조회수 순으로 정리했어요.</p>
${calc.length ? `<p>계산기: ${calc.map(([p, n]) => `<a href="${CALC}/${p}/">${n}</a>`).join(' · ')}</p>` : ''}
${svcList(l, today)}` }));
  }
  write('/c/', page({ title: '분야별 정부 지원금 | 정부 지원금 찾기', p: '/c/', desc: '생활안정·주거·보육·고용·의료 등 분야별 정부 지원금과 공공서비스 목록.',
    body: `<p class="hint"><a href="/">홈</a> › 분야별</p><h1>분야별 정부 지원금</h1>
<ul class="chips">${fields.map((f) => `<li><a href="${href(`/c/${slug(f)}/`)}">${esc(f)} <span class="c">${comma(byField.get(f).length)}</span></a></li>`).join('')}</ul>` }));

  // 지역 (시도 → 시군구)
  const bySido = new Map();
  for (const s of svcs) if (s.region.sido) {
    const R = bySido.get(s.region.sido) || bySido.set(s.region.sido, { own: [], sgg: new Map() }).get(s.region.sido);
    if (!s.region.sgg) R.own.push(s); else (R.sgg.get(s.region.sgg) || R.sgg.set(s.region.sgg, []).get(s.region.sgg)).push(s);
  }
  const sidoList = SIDOS.filter((n) => bySido.has(n));
  const nNational = svcs.filter((s) => !s.region.sido).length;
  for (const sd of sidoList) {
    const R = bySido.get(sd), sggs = [...R.sgg.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
    const total = R.own.length + sggs.reduce((a, g) => a + R.sgg.get(g).length, 0);
    const P = `/r/${slug(sd)}/`;
    write(P, page({ title: `${sd} 지원금·지자체 혜택 ${comma(total)}개 | 정부 지원금 찾기`, p: P, noindex: ![...R.own, ...[...R.sgg.values()].flat()].some(hasIdx), ld: crumbs([['홈', '/'], ['지역별', '/r/'], [sd, P]]),
      desc: `${sd}와 시·군·구가 운영하는 지원금·공공서비스 ${total}개. 시군구별 목록과 신청 방법.`,
      body: `<p class="hint"><a href="/">홈</a> › <a href="/r/">지역별</a> › ${esc(sd)}</p>
<h1>${esc(sd)} 지원금·혜택 (${comma(total)}개)</h1>
<p class="lead">${esc(sd)} 본청 ${comma(R.own.length)}개, 시·군·구 ${comma(total - R.own.length)}개예요. 전국 공통(중앙부처·공공기관) 서비스 ${comma(nNational)}개는 <a href="/">홈 검색</a>에서 함께 볼 수 있어요.</p>
${sggs.length ? `<h2>시·군·구별</h2><ul class="chips">${sggs.map((g) => `<li><a href="${href(`${P}${slug(g)}/`)}">${esc(g)} <span class="c">${R.sgg.get(g).length}</span></a></li>`).join('')}</ul>` : ''}
<h2>${esc(sd)} 본청 서비스 (${comma(R.own.length)}개)</h2>${svcList(R.own.sort(byViews), today)}` }));
    for (const g of sggs) {
      const l = R.sgg.get(g).sort(byViews), GP = `${P}${slug(g)}/`;
      write(GP, page({ title: `${sd} ${g} 지원금·혜택 ${comma(l.length)}개 | 정부 지원금 찾기`, p: GP, noindex: !l.some(hasIdx), ld: crumbs([['홈', '/'], [sd, P], [g, GP]]),
        desc: `${sd} ${g}의 지원금·공공서비스 ${l.length}개. 지원 대상, 지원 내용, 신청 방법과 기한.`,
        body: `<p class="hint"><a href="/">홈</a> › <a href="${href(P)}">${esc(sd)}</a> › ${esc(g)}</p>
<h1>${esc(sd)} ${esc(g)} 지원금·혜택 (${comma(l.length)}개)</h1>
<p class="lead">${esc(g)}에서 운영하는 공공서비스예요. <a href="${href(P)}">${esc(sd)} 본청 서비스</a>와 전국 공통 서비스도 함께 확인하세요.</p>
${svcList(l, today)}` }));
    }
  }
  write('/r/', page({ title: '지역별 지원금·지자체 혜택 | 정부 지원금 찾기', p: '/r/', desc: '시도·시군구별 지자체 지원금과 공공서비스 목록.',
    body: `<p class="hint"><a href="/">홈</a> › 지역별</p><h1>지역별 지원금·혜택</h1>
<ul class="chips">${sidoList.map((sd) => { const R = bySido.get(sd); return `<li><a href="${href(`/r/${slug(sd)}/`)}">${esc(sd)} <span class="c">${comma(R.own.length + [...R.sgg.values()].reduce((a, l) => a + l.length, 0))}</span></a></li>`; }).join('')}</ul>` }));

  // 대상 랜딩 /t/<slug>/
  const byT = new Map(TARGETS.map((t) => [t.label, []]));
  for (const s of svcs) for (const l of s.tags) byT.get(l).push(s);
  const year = today.slice(0, 4);
  for (const t of TARGETS) {
    const l = byT.get(t.label).sort(urgentFirst(today)), P = tPath(t);
    const sds = sidoList.filter((sd) => l.some((s) => s.region.sido === sd)), fds = fields.filter((f) => l.some((s) => (s.서비스분야 || '기타') === f));
    write(P, page({ title: `${year} ${t.label} 지원금·혜택 모음 (${comma(l.length)}건) | 정부 지원금 찾기`, p: P, noindex: targetNoindex(l),
      desc: clip(`${t.label} 대상 정부·지자체 지원금과 혜택 ${l.length}건. ${t.intro} 마감 임박 순으로 정리하고 매일 갱신해요.`, 155),
      ld: crumbs([['홈', '/'], ['대상별', '/t/'], [t.label, P]]),
      body: `<p class="hint"><a href="/">홈</a> › <a href="/t/">대상별</a> › ${esc(t.label)}</p>
<h1>${year} ${esc(t.label)} 지원금·혜택 모음 (${comma(l.length)}건)</h1>
<p class="lead">${esc(t.intro)} 신청 마감이 가까운 것부터, 그다음은 최근 수정된 순서로 보여 드려요.</p>
${t.links.length ? `<p>함께 보기: ${t.links.map(([u, n]) => `<a href="${esc(u)}">${esc(n)}</a>`).join(' · ')}</p>` : ''}
<div class="card filters" id="tf">
<label>지역<select id="tsd"><option value="">전체</option><option value="-1">전국 공통만</option>${sds.map((sd) => `<option value="${sidoList.indexOf(sd)}">${esc(sd)}</option>`).join('')}</select></label>
<label>분야<select id="tfd"><option value="">전체</option>${fds.map((f) => `<option value="${fields.indexOf(f)}">${esc(f)}</option>`).join('')}</select></label>
<label class="chk"><input type="checkbox" id="tnat" checked> 지역 선택 시 전국 공통 포함</label>
</div>
<p id="tsum" class="sum" aria-live="polite"></p>
${svcList(l, today, Infinity, (s) => ` data-r="${sidoList.indexOf(s.region.sido)}" data-f="${fields.indexOf(s.서비스분야 || '기타')}"`)}
<p class="hint">대상 분류는 보조금24 지원조건과 지원대상 문구로 자동으로 나눈 것이라 일부 맞지 않을 수 있어요. 자격은 각 서비스의 선정 기준에서 확인하세요.</p>
<script src="/home.js" defer></script>` }));
  }
  const tChips = (g) => `<ul class="chips">${TARGETS.filter((t) => t.group === g).map((t) => `<li><a href="${href(tPath(t))}" data-t="${TARGETS.indexOf(t)}">${esc(t.label)} <span class="c">${comma(byT.get(t.label).length)}</span></a></li>`).join('')}</ul>`;
  write('/t/', page({ title: '대상별 정부 지원금 (신혼부부·임산부·청년·소상공인·중소기업) | 정부 지원금 찾기', p: '/t/',
    desc: '신혼부부, 임산부, 출산, 영유아, 청년, 노인, 장애인, 소상공인, 중소기업 등 대상별 정부·지자체 지원금 모음.',
    body: `<p class="hint"><a href="/">홈</a> › 대상별</p><h1>대상별 정부 지원금</h1>
${GROUPS.map((g) => `<h2>${esc(g)}</h2>${tChips(g)}`).join('\n')}` }));

  // 검색 색인 (홈 JS가 읽음): [id, 이름, 기관, 분야#, 시도#, 시군구, 태그비트, 소득비트, 온라인, 마감, 요약, 나이from, 나이to]
  const idx = { f: fields, s: sidoList, t: TARGETS.map((t) => t.label), ts: TARGETS.map((t) => t.slug), d: svcs.map((s) => [s.서비스ID, s.서비스명, s.소관기관명, fields.indexOf(s.서비스분야 || '기타'), sidoList.indexOf(s.region.sido),
    s.region.sgg, s.tags.reduce((m, t) => m | (1 << TARGETS.indexOf(TBY.get(t))), 0), s.inc, s.online ? 1 : 0, s.deadline, clip(s.서비스목적요약, 50), s.age[0], s.age[1]]) };
  fs.writeFileSync(path.join(OUT, 'data', 'index.json'), JSON.stringify(idx));

  // 홈
  const soon = svcs.filter((s) => s.deadline >= today && Date.parse(s.deadline) - Date.parse(today) <= 30 * DAY).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const recentNew = [...svcs].sort((a, b) => String(b.등록일시 || '').localeCompare(String(a.등록일시 || '')));
  const recentMod = [...svcs].sort((a, b) => String(b.수정일시 || '').localeCompare(String(a.수정일시 || '')));
  const opt = (arr) => arr.map((v, i) => `<option value="${i}">${esc(v)}</option>`).join('');
  write('/', page({ title: '정부 지원금 찾기 | 나이·지역·소득으로 보조금·혜택 검색', p: '/',
    desc: `중앙부처·지자체 지원금과 공공서비스 ${comma(svcs.length)}개를 나이·생애주기·지역·분야·소득으로 찾아보세요. 신청 마감 임박 서비스와 새 서비스를 매일 갱신해요.`,
    body: `<h1>정부 지원금 찾기</h1>
<p class="lead">보조금24의 공공서비스 <b>${comma(svcs.length)}개</b>를 매일 새벽 모아 두었어요. 조건을 고르면 받을 수 있을 만한 지원금을 추려 드려요.</p>
<div class="card tgroups" id="tbtn"><b>누구를 위한 지원금을 찾으세요?</b>
${GROUPS.map((g) => `<h3>${esc(g)}</h3>${tChips(g)}`).join('\n')}</div>
<div class="card filters">
<label style="grid-column:1/-1">검색어<input type="text" id="q" placeholder="예: 월세, 출산, 장학금, 근로장려금" autocomplete="off"></label>
<label>대상<select id="tg"><option value="">전체</option>${opt(TARGETS.map((t) => t.label))}</select></label>
<label>나이<input type="number" id="ag" min="0" max="120" inputmode="numeric" placeholder="만 나이"></label>
<label>시도<select id="sd"><option value="">전체 지역</option>${opt(sidoList)}</select></label>
<label>시군구<select id="sg"><option value="">전체</option></select></label>
<label>분야<select id="fd"><option value="">전체 분야</option>${opt(fields)}</select></label>
<label>소득(기준 중위소득)<select id="ic"><option value="">상관없음</option>${opt(INCOME)}</select></label>
<label class="chk"><input type="checkbox" id="nat" checked> 전국 공통 포함</label>
<label class="chk"><input type="checkbox" id="on"> 온라인 신청만</label>
</div>
<p id="sum" class="sum" aria-live="polite"></p>
<ul id="list" class="svc"></ul>
<button type="button" id="more" class="more" hidden>더 보기</button>
<h2>⏰ 신청 마감 임박 (30일 이내, ${soon.length}개)</h2>${svcList(soon, today, 20)}
<h2>🆕 최근 등록</h2>${svcList(recentNew, today, 15)}
<h2>✏️ 최근 수정</h2>${svcList(recentMod, today, 15)}
<h2>분야별</h2><ul class="chips">${fields.map((f) => `<li><a href="${href(`/c/${slug(f)}/`)}">${esc(f)} <span class="c">${comma(byField.get(f).length)}</span></a></li>`).join('')}</ul>
<h2>지역별</h2><ul class="chips">${sidoList.map((sd) => `<li><a href="${href(`/r/${slug(sd)}/`)}">${esc(sd)}</a></li>`).join('')}</ul>
<p class="hint">나이·소득 조건은 보조금24의 지원조건 자료 기준이에요. 조건이 등록되지 않은 서비스는 모든 나이·소득에 표시돼요.</p>
<script src="/home.js" defer></script>` }));

  write('/privacy.html', page({ title: '개인정보처리방침 | 정부 지원금 찾기', p: '/privacy.html', desc: '정부 지원금 찾기 개인정보처리방침',
    body: `<h1>개인정보처리방침</h1><div class="card">
<p>정부 지원금 찾기(grant.hanbogi.com)는 회원가입이 없고 <b>개인정보를 수집하거나 저장하지 않아요</b>. 검색 조건(나이·지역·소득 등)은 브라우저 안에서만 쓰이고 서버로 보내지 않아요.</p>
<p>이 사이트는 Google 애드센스 광고를 게재할 수 있어요. Google 및 제3자 광고 사업자는 쿠키를 사용해 이 사이트와 다른 사이트 방문 기록을 바탕으로 광고를 제공할 수 있어요. <a href="https://adssettings.google.com" rel="nofollow">Google 광고 설정</a>에서 맞춤 광고를 끌 수 있어요.</p>
<p>방문 통계를 위해 Google 애널리틱스를 사용해요. 쿠키로 방문 페이지·기기·대략적 지역 같은 익명 통계를 모으며, 브라우저 설정에서 쿠키를 거부하거나 <a href="https://tools.google.com/dlpage/gaoptout" rel="nofollow">Google 애널리틱스 차단 부가기능</a>을 쓸 수 있어요.</p>
<p>문의: 혜택 알리미 블로그(<a href="${BENEFIT}">benefit.hanbogi.com</a>) 방명록</p>
<p class="hint">시행일: 2026년 9월 27일</p></div>` }));
  write('/404.html', page({ title: '페이지를 찾을 수 없어요 | 정부 지원금 찾기', p: '/404.html', desc: '페이지를 찾을 수 없어요', noindex: true,
    body: '<h1>페이지를 찾을 수 없어요</h1><p class="lead">주소가 바뀌었거나 종료된 서비스일 수 있어요.</p><p><a href="/">홈에서 검색하기</a> · <a href="/c/">분야별</a> · <a href="/r/">지역별</a></p>' }));

  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  const sm = sitemaps(indexable, today);
  for (const [f, c] of Object.entries(sm)) fs.writeFileSync(path.join(OUT, f), c);

  console.log(`완료: 서비스 ${svcs.length} (색인 ${svcs.filter((s) => s.indexable).length}), 페이지 ${pages}개 (사이트맵 ${indexable.length}, 파일 ${Object.keys(sm).length}), 마감 임박 ${soon.length}`);
  console.log('API 호출 수:', FIX ? '(fixtures)' : calls);
}

module.exports = { parseDeadline, regionOf, incomeMask, isMeaningful, isOnline, sitemaps, calcLinks, normDate, slug, targetNoindex, urgentFirst, TARGET_MIN };
if (require.main === module) main().catch((e) => { console.error('❌ 빌드 실패:', e.message); process.exit(e.auth ? 3 : 1); });
