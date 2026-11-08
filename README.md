# 우리집 관리비 (동탄역 포레너스 · 84㎡)

이 앱은 `index.html` 파일 하나로 동작합니다. 관리비 고지서 캡처를 Claude가 읽어 항목별로 정리하고, 지난달과 비교하고, 월별 추이를 보여 줍니다.

## 파일
| 파일 | 역할 |
|---|---|
| `index.html` | 앱 전체 (화면, 분석, 저장, 차트) |
| `logo.png` *(선택)* | 아파트 CI 이미지. 이 파일이 있으면 헤더에 표시하고, 없으면 내장된 SVG 마크를 씁니다 |
| `proxy/worker.js`, `proxy/wrangler.toml` | 배포할 때 API 키를 숨기는 Cloudflare Worker 프록시 |

## 화면 흐름
```
대시보드(#/) ─ 이번 달 총액·증감 → 특이사항 → 12개월 미니차트·TOP3 → 항목별 증감표 → 절약 팁
   │
등록(#/upload) ─ 촬영/앨범 선택 → [AI로 분석] → 결과 확인·수정(연월, 금액, 사용량) → [확인하고 저장]
   │                         └ [직접 입력] (API 키가 없어도 사용 가능)
추이(#/trends) ─ 연간 요약(합계·월평균·최고 달) → 12개월 총액 → 항목별 추이(금액+사용량) → 작년 같은 달 비교
기록(#/records) ─ 월별 목록 → 상세(#/record/YYYY-MM): 원본 이미지 + 분석표 → 수정 / 삭제
설정(#/settings) ─ API 키·프록시·모델 / 우리 집 정보 / CSV·JSON 백업·복원 / 샘플 데이터
```

## 데이터 구조 (IndexedDB `apt-bill-db`)
```jsonc
// bills (월마다 1건, id = 부과연월)
{
  "id": "2026-10", "yearMonth": "2026-10",
  "items": [
    { "name": "세대전기료", "rawLabel": "전기료", "amount": 58230, "usage": 352, "unit": "kWh" },
    { "name": "잡수입공제", "rawLabel": "잡수입", "amount": -1800, "usage": null, "unit": "" }
  ],
  "total": 289400,          // 항목 합계 (분석 기준)
  "billedTotal": 289400,    // 고지서에 적힌 합계 (검증용)
  "memo": "", "source": "ai | manual | sample", "imageCount": 2,
  "createdAt": "...", "updatedAt": "...", "schemaVersion": 1
}
// images: { "billId": "2026-10", "images": ["data:image/jpeg;base64,..."] }
// kv['settings']: { apiKey, proxyUrl, model, household: { aptName, pyeong, area, members, heating } }
```
화면 코드는 `repo` 객체의 메서드(`listBills/getBill/putBill/deleteBill/getImages/putImages/getSettings/saveSettings`)만 씁니다. 서버로 옮길 때는 같은 메서드를 가진 `createApiRepo()`(코드에 예시 주석이 있습니다)를 만들어 `repo`만 교체하면 됩니다. 이미 쌓인 데이터는 **설정 → 전체 백업(JSON)** 으로 내보내 서버 DB에 넣으면 됩니다.

---

## 실제로 쓰기: 단계별 안내

### 1단계. Claude API 키 발급
1. https://platform.claude.com 에 가입하고 로그인합니다. claude.ai 구독과는 별개의 계정·결제입니다.
2. **Billing**에서 결제 수단을 등록하고 크레딧을 충전합니다. 소액(예: $5)으로도 충분합니다.
3. **API Keys → Create Key**에서 키를 만들어 `sk-ant-...` 값을 복사해 둡니다.
4. **Limits**에서 월 사용 한도를 낮게 잡아 두는 것을 권장합니다.

> 비용 감: 고지서 1장 분석은 이미지 몇 장과 짧은 응답이라 기본 모델(Opus 5.5) 기준 1회 수십 원 수준입니다. 설정에서 Sonnet/Haiku를 고르면 더 저렴합니다.

### 2단계. 내 PC에서 바로 쓰기 (가장 간단)
1. `index.html`을 더블클릭해서 Chrome이나 Edge로 엽니다.
2. **설정**에 API 키를 붙여 넣고 저장합니다. 키는 이 브라우저에만 저장됩니다.
3. **등록**에서 캡처를 올리고 **AI로 분석하기**를 누릅니다.
4. (선택) 아파트 CI 이미지를 `logo.png`라는 이름으로 같은 폴더에 두면 헤더 로고로 표시됩니다.

> 이 방식은 API 키가 브라우저에 저장되므로 **본인 기기에서 혼자 쓸 때만** 사용하세요.

### 3단계. 휴대폰에서도 쓰기: 배포 + 프록시 (권장)
휴대폰에서 바로 촬영해 올리려면 앱을 인터넷 주소로 열 수 있어야 합니다. 이때는 키를 프록시 뒤에 숨깁니다.

**(a) 앱 배포: Cloudflare Pages (무료)**
1. https://dash.cloudflare.com 가입 → **Workers & Pages → Create → Pages → Upload assets**
2. 프로젝트 이름(예: `apt-bill`)을 정하고 `index.html`(+`logo.png`)이 든 폴더를 업로드합니다.
3. `https://apt-bill.pages.dev` 같은 주소가 생깁니다.
4. 가족만 쓰도록 **Zero Trust → Access**로 이메일 로그인 보호를 거는 것을 권장합니다(무료 플랜 가능).

**(b) 프록시 배포: Cloudflare Worker**
```bash
npm install -g wrangler
wrangler login
cd proxy
# wrangler.toml의 ALLOWED_ORIGIN을 (a)의 앱 주소로 수정한 뒤
wrangler secret put ANTHROPIC_API_KEY   # sk-ant-... 입력
wrangler secret put APP_PASSCODE        # 가족끼리 쓸 접속 암호 입력
wrangler deploy                         # → https://apt-bill-proxy.<계정>.workers.dev
```

**(c) 앱 설정**
- 휴대폰에서 앱 주소를 열고 **설정**에 들어갑니다.
  - 프록시 주소: `https://apt-bill-proxy.<계정>.workers.dev`
  - API 키 칸: (b)에서 정한 **APP_PASSCODE** (실제 API 키가 아닙니다)
- 브라우저 메뉴의 **홈 화면에 추가**를 누르면 앱처럼 쓸 수 있습니다.

> 데이터는 기기별 브라우저에 따로 저장됩니다. 폰과 PC가 같은 데이터를 보게 하려면 JSON 백업·복원을 쓰거나, 다음 단계에서 서버 저장소로 옮기세요.

### 4단계 (나중에). 서버 저장소로 이전
- Cloudflare D1(SQLite) + Worker API, Supabase, Firebase 중 하나에 `bills` / `images` 테이블을 만듭니다. 이미지는 R2나 Storage에 두고 URL만 저장합니다.
- `createApiRepo()`를 구현하고 `const repo = createApiRepo('https://...')`로 바꿉니다.
- 기존 JSON 백업을 한 번 업로드해 데이터를 옮깁니다.

## 특이사항 감지 기준
- **급증/급감**: 전월 대비 ±20% 이상, 차액 500원 이상 (몇백 원짜리 소액 항목의 % 변동은 제외)
- **신규/사라짐**: 지난달에 없던(0원 포함) 항목, 또는 이번 달에 없는 항목
- **단가 인상 의심**: 사용량 변화는 ±10% 이내인데 단위당 요금이 10% 이상 오른 항목
