// node test.js — 핵심 순수 함수 검사
const assert = require('assert');
const { parseDeadline, regionOf, incomeMask, isMeaningful, isOnline, sitemaps, calcLinks, normDate, slug, targetNoindex, urgentFirst, TARGET_MIN } = require('./build.js');
const { targetsOf, TARGETS } = require('./targets.js');

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

// 대상 분류 (targets.js)
const S = (o) => ({ 서비스명: '', 지원대상: '', 선정기준: '', 사용자구분: '개인', 서비스분야: '', ...o });
const has = (s, c, l) => targetsOf(S(s), c).includes(l);
const ALLY = Object.fromEntries(['JA0301', 'JA0302', 'JA0303', 'JA0313', 'JA0314', 'JA0315', 'JA0316', 'JA0317', 'JA0318', 'JA0319', 'JA0320', 'JA0326', 'JA0327', 'JA0328', 'JA0329', 'JA0330',
  'JA0401', 'JA0402', 'JA0403', 'JA0404', 'JA0411', 'JA0412', 'JA0413', 'JA0414'].map((k) => [k, 'Y'])); // 전부 Y = 제한 없음
assert.strictEqual(new Set(TARGETS.map((t) => t.slug)).size, TARGETS.length); // slug 중복 없음
assert.ok(TARGETS.length <= 31); // 색인 비트마스크 한도
// 신혼부부: 키워드 + 부정 가드
assert.ok(has({ 서비스명: '주택자금 이자 지원', 지원대상: '○ 혼인 7년 이내 무주택 가구' }, null, '신혼부부'));
assert.ok(has({ 서비스명: '청년 전세 이자', 지원대상: '19~39세 청년 또는 신혼부부' }, null, '신혼부부'));
assert.ok(!has({ 서비스명: '청년 월세 지원', 지원대상: '만 19~34세 청년 (단, 신혼부부 제외)' }, null, '신혼부부'));
assert.ok(!has({ 서비스명: '청년 월세 지원', 지원대상: '만 19~34세 청년', 선정기준: '※ 신혼부부는 지원 불가' }, null, '신혼부부'));
assert.ok(!has({ 서비스명: '결혼이민자 한국어 교육', 지원대상: '결혼이민자' }, null, '신혼부부'));
// 코드: 좁혔을 때만 신호, 전부 Y면 무시
assert.ok(has({ 서비스명: '아이소망 지원사업', 지원대상: '체외수정 시술자' }, { JA0301: 'Y' }, '임산부'));
assert.ok(!has({ 서비스명: '생활지원', 지원대상: '관내 주민' }, ALLY, '장애인'));
assert.ok(has({ 서비스명: '활동보조', 지원대상: '등록 주민' }, { JA0328: 'Y' }, '장애인'));
assert.ok(has({ 서비스명: '첫만남이용권' }, { JA0303: 'Y' }, '출산·산모'));
assert.ok(!has({ 서비스명: '1990년 이후 출생자 건강검진', 지원대상: '1990. 1. 1. 이후 출생한 주민' }, null, '출산·산모')); // 생년 "출생"은 출산 아님
// 나이 코드
assert.ok(has({ 서비스명: '월세 지원' }, { JA0110: 19, JA0111: 34 }, '청년'));
assert.ok(!has({ 서비스명: '육아용품 지원' }, { JA0110: 19, JA0111: 45 }, '청년')); // 부모 나이 19~45는 청년 아님
assert.ok(has({ 서비스명: '기초연금' }, { JA0110: 65, JA0111: 150 }, '노인'));
assert.ok(has({ 서비스명: '부모급여' }, { JA0110: 0, JA0111: 1 }, '영유아'));
assert.deepStrictEqual(targetsOf(S({ 서비스명: '생활지원' }), { JA0110: 0, JA0111: 100 }), []); // 전 연령은 대상 없음
// 저소득·1인 가구·다문화
assert.ok(has({ 서비스명: 'x' }, { JA0201: 'Y', JA0202: 'Y' }, '저소득'));
assert.ok(!has({ 서비스명: 'x' }, { JA0201: 'Y', JA0204: 'Y' }, '저소득'));
assert.ok(has({ 서비스명: '고독사 예방', 지원대상: '홀로 사는 중장년' }, null, '1인 가구'));
assert.ok(has({ 서비스명: '고향방문 지원', 지원대상: '결혼이민자 가정' }, null, '다문화'));
// 나열형 가드: 여러 대상을 나열한 범용 감면은 키워드로 넣지 않되, 서비스명에 있으면 인정
const list = { 서비스명: '체육시설 이용료 감면', 지원대상: '기초생활수급자, 장애인, 국가유공자, 한부모가족, 다자녀 가정' };
assert.ok(!has(list, null, '한부모') && !has(list, null, '보훈'));
assert.ok(has({ ...list, 서비스명: '장애인 체육시설 이용료 감면' }, null, '장애인'));
assert.ok(!has({ 서비스명: '농민 공익수당', 지원대상: '신청년도 직전 1년 이상 거주 농민' }, null, '청년')); // "신청년도" 오탐 방지
// 사업자
assert.ok(has({ 서비스명: '수출 바우처', 지원대상: '도내 중소기업', 사용자구분: '법인/시설/단체' }, null, '중소기업'));
assert.ok(!has({ 서비스명: '청년 근속 장려금', 지원대상: '중소기업에 재직 중인 청년', 사용자구분: '개인' }, null, '중소기업')); // 개인용
assert.ok(has({ 서비스명: '경영 개선', 지원대상: '관내 사업자' }, { JA2101: 'Y' }, '중소기업'));
assert.ok(has({ 서비스명: '경영안정자금', 지원대상: '관내 소상공인', 사용자구분: '소상공인' }, null, '소상공인'));
assert.ok(has({ 서비스명: '예비창업패키지', 지원대상: '예비창업자' }, null, '예비창업자·창업'));
assert.ok(!has({ 서비스명: '면접 정장 대여', 지원대상: '미취업 청년', 선정기준: '고용보험 가입자 또는 창업자' }, null, '예비창업자·창업')); // 선정기준은 안 봄
assert.ok(has({ 서비스명: '면접 정장 대여', 지원대상: '미취업 청년' }, null, '구직자·실업자'));
assert.ok(has({ 서비스명: '농기계 지원', 지원대상: '관내 농업인' }, null, '농어업인'));
assert.ok(!has({ 서비스명: '경로당 운영비', 지원대상: '관내 경로당', 사용자구분: '법인/시설/단체' }, null, '법인·기업'));

// 대상 랜딩: noindex 기준 + 정렬
const ix = (n, idx = true) => Array.from({ length: n }, () => ({ indexable: idx }));
assert.strictEqual(TARGET_MIN, 3);
assert.ok(targetNoindex(ix(2)));
assert.ok(!targetNoindex(ix(3)));
assert.ok(targetNoindex(ix(5, false))); // 색인할 서비스 없음
const ord = [{ id: 'a', deadline: '', 수정일시: '20260901' }, { id: 'b', deadline: '2026-10-20' }, { id: 'c', deadline: '2026-01-01', 수정일시: '20260920' }, { id: 'd', deadline: '2026-10-01' }]
  .sort(urgentFirst('2026-09-27')).map((s) => s.id);
assert.deepStrictEqual(ord, ['d', 'b', 'c', 'a']);
assert.strictEqual(incomeMask({ JA0201: 'Y', JA0203: 'Y' }), 0b101);
assert.strictEqual(incomeMask(null), 0);

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
