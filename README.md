# fukuoka-beppu-trip

후쿠오카·벳푸 여행 일정 PWA. 일정을 **구분(공항·숙소·관광·식당·쇼핑)·장소·시간·메모·좌표**로 입력하고
3가지 방식으로 시각화 + 정보 입력 탭.

## 4개 탭

1. **시간표** — 가로=일자(Day), 세로=시간 격자. 종류별 색상 블록.
2. **지도** — MapTiler(한국어 라벨) 지도 위 장소 핀 + **일자별 시간순 경로선**(흰 케이싱 반투명 실선). 시작시간·장소 라벨, 종류별 색상. 상단 일자 필터.
3. **경로** — 일자별 장소를 점(종류 아이콘)으로 잇는 실선 타임라인. 점마다 시간·장소·설명.
4. **상세** — 입력 탭. 구분/장소/시간/메모 + 좌표(직접 입력 또는 `📍 좌표` 로 장소명 자동 검색). 항목마다 **커스텀 아이콘** 선택 가능(미지정 시 종류 기본).

## 구분(종류)

| id | 라벨 | 아이콘 | 색 |
|----|------|--------|----|
| `airport`  | 공항 | ✈️ | 하늘 |
| `hotel`    | 숙소 | 🏨 | 보라 |
| `sight`    | 관광 | 🎡 | 분홍 |
| `food`     | 식당 | 🍜 | 주황 |
| `shopping` | 쇼핑 | 👠 | 노랑 |

## 구조

```
fukuoka-beppu-trip/
├── index.html
├── manifest.webmanifest
├── sw.js
├── assets/{app.js, app.css, icon.svg, icon-maskable.svg}
├── data/default.json        # 첫 실행 fallback (샘플 3일 일정)
└── worker/                  # Cloudflare Worker — 데이터 동기화 API
    ├── src/index.js
    ├── package.json
    └── wrangler.toml
```

## 지도 (MapTiler 한국어) 설정

지도 탭은 한국어 라벨을 위해 [MapTiler](https://cloud.maptiler.com) 를 씁니다.

1. cloud.maptiler.com 가입 → **무료 플랜**(신용카드 불필요, 월 10만 타일).
2. 대시보드 → **API Keys** 에서 키 복사.
3. `assets/app.js` 의 `MAPTILER_KEY = 'REPLACE_WITH_MAPTILER_KEY'` 를 발급 키로 교체.
4. (권장) MapTiler 대시보드에서 키의 **허용 도메인**을 본인 배포 주소로 제한.

키는 클라이언트(app.js)에 노출되지만 도메인 제한으로 보호합니다.

## 로컬 실행

```sh
cd fukuoka-beppu-trip
python3 -m http.server 8000
open http://localhost:8000/
```

## 데이터 모델

```json
{
  "version": 1,
  "entries": [
    {
      "id": "e1",
      "day": "d1",
      "kind": "airport",
      "place": "후쿠오카공항 도착",
      "start": "10:00",
      "end": "11:00",
      "memo": "지하철로 하카타역 이동",
      "icon": "",
      "lat": 33.5946,
      "lng": 130.4510
    }
  ]
}
```

- `day`: `d1`–`d5` (여행 일자 — 늘리려면 `assets/app.js` 의 `DAYS` 수정)
- `kind`: `airport|hotel|sight|food|shopping`
- `icon`: 커스텀 아이콘(이모지). 빈 값이면 `kind` 기본 아이콘 사용 (선택지는 `assets/app.js` 의 `ICON_SET`)
- `start` 필수(시간표·정렬 기준), `end`·`memo`·`lat`·`lng` 선택
- 시간표 블록은 `end` 가 없으면 시작 +90분으로 표시

## Worker 배포

```sh
cd worker
npx wrangler kv namespace create TRIP
# 출력 id 를 wrangler.toml 의 REPLACE_WITH_KV_ID 에 채워넣기
npx wrangler secret put EDIT_TOKEN
# 편집 비밀번호 입력
npx wrangler deploy
```

배포 후 출력된 workers.dev URL 을 `assets/app.js` 의 `API_BASE` 에 반영.
(GitHub Pages 등 배포 도메인은 `worker/src/index.js` 의 `ALLOWED_ORIGINS` 에 추가.)

## 편집 권한

기본은 읽기 전용. 헤더의 `🔒` 버튼을 눌러 `EDIT_TOKEN` 비밀번호를 입력하면 편집 모드로 전환.
편집 모드에서 입력하면 로컬 저장 + 서버(KV) 자동 동기화.
