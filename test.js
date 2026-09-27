// node test.js — 핵심 순수 함수 검사
const assert = require('assert');
const { parseDeadline, regionOf, tagsOf, incomeMask, isMeaningful, isOnline, sitemaps, calcLinks, normDate, slug } = require('./build.js');

// 신청기한
assert.strictEqual(parseDeadline('상시신청'), '');
assert.strictEqual(parseDeadline(''), '');
assert.strictEqual(parseDeadline(null), '');
assert.strictEqual(parseDeadline('2026-10-05'), '2026-10-05');
assert.strictEqual(parseDeadline('2026.10.15.까지 (예산 소진 시 조기 마감)'), '2026-10-15');
assert.strictEqual(parseDeadline('2026. 2. 26. ~ 2026. 10. 15.'), '2026-10-15');
assert.strictEqual(parseDeadline('2026. 10. 1. ~ 10. 31.'), '2026-10-31'); // 끝 날짜 연도 생략
assert.strictEqual(parseDeadline('2026년 10월 20일'), '2026-10-20');
assert.strictEqual(parseDeadline('정기신청: 2026. 5. 1. ~ 2026. 6. 1.\n기한 후 신청: 2026. 6. 2. ~ 2026. 12. 1.'), '2026-12-01');
assert.strictEqual(parseDeadline('2026. 2. 30.'), ''); // 없는 날짜
assert.strictEqual(parseDeadline('매년 3월~4월'), '');
assert.strictEqual(parseDeadline('출생일로부터 1년 이내'), '');

// 지역
assert.deepStrictEqual(regionOf('보건복지부'), { sido: '', sgg: '' });
assert.deepStrictEqual(regionOf('서울특별시'), { sido: '서울특별시', sgg: '' });
assert.deepStrictEqual(regionOf('서울특별시 강남구'), { sido: '서울특별시', sgg: '강남구' });
assert.deepStrictEqual(regionOf('경기도 수원시 장안구'), { sido: '경기도', sgg: '수원시 장안구' });
assert.deepStrictEqual(regionOf('경기도 수원시'), { sido: '경기도', sgg: '수원시' });
assert.deepStrictEqual(regionOf('충청북도 괴산군'), { sido: '충청북도', sgg: '괴산군' });
assert.deepStrictEqual(regionOf('강원도 춘천시'), { sido: '강원특별자치도', sgg: '춘천시' }); // 옛 이름
assert.deepStrictEqual(regionOf('전라북도 전주시 완산구'), { sido: '전북특별자치도', sgg: '전주시 완산구' });
assert.deepStrictEqual(regionOf('서울특별시교육청'), { sido: '서울특별시', sgg: '' });
assert.deepStrictEqual(regionOf('부산광역시 해운대구 보건소'), { sido: '부산광역시', sgg: '해운대구' });

// 태그·소득
const S = (o) => ({ 서비스명: '', 지원대상: '', 사용자구분: '개인', 서비스분야: '', ...o });
assert.deepStrictEqual(tagsOf(S({ 서비스명: '월세 지원' }), { JA0110: 19, JA0111: 34 }), ['청년']);
assert.deepStrictEqual(tagsOf(S({ 서비스명: '기초연금' }), { JA0110: 65, JA0111: 150 }), ['노인']);
assert.deepStrictEqual(tagsOf(S({ 서비스명: '부모급여' }), { JA0110: 0, JA0111: 1 }), ['영유아']);
assert.deepStrictEqual(tagsOf(S({ 서비스명: '생활지원' }), { JA0110: 0, JA0111: 100 }), []); // 전 연령은 태그 없음
assert.deepStrictEqual(tagsOf(S({ 서비스명: '첫만남이용권' }), { JA0303: 'Y' }), ['임신·출산']);
assert.deepStrictEqual(tagsOf(S({ 서비스명: '주택자금 이자', 지원대상: '신혼부부' }), null), ['신혼']);
assert.strictEqual(incomeMask({ JA0201: 'Y', JA0203: 'Y' }), 0b101);
assert.strictEqual(incomeMask(null), 0);
assert.ok(tagsOf(S({ 서비스명: 'x' }), { JA0201: 'Y', JA0202: 'Y' }).includes('저소득'));
assert.ok(!tagsOf(S({ 서비스명: 'x' }), { JA0201: 'Y', JA0204: 'Y' }).includes('저소득'));

assert.ok(isOnline({ 온라인신청사이트URL: 'https://www.bokjiro.go.kr' }));
assert.ok(isOnline({ 신청방법: '복지로 온라인신청' }));
assert.ok(!isOnline({ 신청방법: '방문' }));

// 색인 기준
assert.ok(!isMeaningful({ 지원대상: '경로당', 선정기준: '', 지원내용: '운영비 지원' }));
assert.ok(!isMeaningful({ 지원대상: '○ 만 19~34세 무주택 청년으로 부모와 떨어져 사는 사람', 선정기준: '중위소득 60% 이하 가구', 지원내용: '' }));
assert.ok(isMeaningful({ 지원대상: '○ 만 19~34세 무주택 청년', 선정기준: '○ 청년가구 소득 기준 중위소득 60% 이하', 지원내용: '○ 월 최대 20만원, 최대 24개월 지원' }));

// 사이트맵 분할
const one = sitemaps(['/', '/s/1/'], '2026-09-27');
assert.deepStrictEqual(Object.keys(one), ['sitemap.xml']);
assert.ok(one['sitemap.xml'].includes('<urlset') && one['sitemap.xml'].includes('https://grant.hanbogi.com/s/1/'));
const many = sitemaps(Array.from({ length: 12 }, (_, i) => `/s/${i}/`), '2026-09-27', 5);
assert.deepStrictEqual(Object.keys(many), ['sitemap-1.xml', 'sitemap-2.xml', 'sitemap-3.xml', 'sitemap.xml']);
assert.strictEqual((many['sitemap-3.xml'].match(/<url>/g) || []).length, 2);
assert.ok(many['sitemap.xml'].includes('<sitemapindex') && many['sitemap.xml'].includes('https://grant.hanbogi.com/sitemap-2.xml'));
assert.ok(sitemaps(['/c/고용-창업/'], 'x')['sitemap.xml'].includes('/c/%EA%B3%A0%EC%9A%A9-%EC%B0%BD%EC%97%85/')); // 한글 경로 인코딩

// 기타
assert.deepStrictEqual(calcLinks({ 서비스명: '근로장려금', 지원내용: '', 서비스분야: '생활안정' }).map((x) => x[0]), ['eitc']);
assert.deepStrictEqual(calcLinks({ 서비스명: '육아휴직 급여', 지원내용: '', 서비스분야: '고용·창업' }).map((x) => x[0]), ['parental-leave', 'salary', 'hourly']);
assert.strictEqual(normDate('20260927151208'), '2026-09-27');
assert.strictEqual(slug('주거·자립'), '주거-자립');
assert.strictEqual(slug('수원시 장안구'), '수원시-장안구');

console.log('test.js: 모두 통과');
