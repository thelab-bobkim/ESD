# DEPLOY — AWS Lightsail(Ubuntu) 배포 가이드

대상 환경(첨부 스크린샷 기준):
- Lightsail Ubuntu 인스턴스, Public IPv4 `3.39.255.201`, ap-northeast-2a(서울)
- 방화벽에 80(HTTP), 443(HTTPS), 22(SSH)가 이미 열려 있음
- 도메인 없음 → **HTTP + Public IP**로 운영 (`docker-compose.prod.yml` + nginx 리버스 프록시)
- ⚠️ 이 서버는 80번 포트를 이미 다른 서비스(`maintenance_system-web`)가 쓰고 있어서, 이 시스템은 **8001번 포트**로 노출한다(방화벽에 이미 열려 있는 8000-8001 규칙 범위).
- 배포 방식: **GitHub 리포지토리 push → 서버에서 clone**

---

## 0. 사전 준비 — GitHub에 코드 올리기 (로컬 PC에서)

이 프로젝트는 사내 HR 정보(조직/사번/근태 등) 스키마를 포함하므로 **Private 리포지토리**를 권장합니다.

> ⚠️ 확인 결과 `thelab-bobkim/ESD` 리포지토리는 현재 **Public**이고 비어 있습니다.
> 코드에 실제 비밀번호나 API 키는 없지만(`.env*`는 `.gitignore`로 제외됨), 회사 조직도/정책 구조 같은
> 내부 정보가 담긴 코드이므로 GitHub 저장소 Settings → Danger Zone → **Change visibility → Private**로
> 바꾸는 것을 권장합니다.

```bash
cd employee-status-system
git init
git add .
git commit -m "init: 전직원 상황판 시스템 파일럿 MVP"
git branch -M main
git remote add origin https://github.com/thelab-bobkim/ESD.git
git push -u origin main
```

> `.env`, `.env.local`, `.env.prod`는 `.gitignore`에 이미 포함되어 커밋되지 않습니다. 실제 비밀번호/시크릿은 서버에서만 설정합니다.

---

## 1. 서버 접속

스크린샷의 **Connect 탭 → "Connect using SSH"**(브라우저 SSH)를 쓰거나, 로컬 터미널에서:

```bash
ssh -i /path/to/your-key.pem ubuntu@3.39.255.201
```

---

## 2. 서버에 Docker / Docker Compose 설치 (Ubuntu, 최초 1회)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# sudo 없이 docker 쓰고 싶으면 (재로그인 필요)
sudo usermod -aG docker $USER
```

설치 확인:
```bash
docker --version
docker compose version
```

---

## 3. 코드 가져오기 & 환경변수 설정

```bash
git clone https://github.com/thelab-bobkim/ESD.git employee-status-system
cd employee-status-system

cp .env.prod.example .env.prod
nano .env.prod   # DB_PASSWORD, JWT_SECRET을 실제 값으로 반드시 변경
```

`.env.prod` 예시(값은 직접 무작위로 바꾸세요):
```
DB_PASSWORD=매우강력한비밀번호_직접입력
JWT_SECRET=랜덤한긴문자열_직접입력
```

---

## 4. 빌드 및 기동

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d
```

- 외부에 노출되는 포트는 **80(nginx)뿐**입니다. frontend(3000)/backend(4000)/db(5432)는 도커 내부 네트워크에서만 통신합니다.
- 최초 빌드는 Prisma 엔진 다운로드 등으로 몇 분 걸릴 수 있습니다.

컨테이너 상태 확인:
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
```

---

## 5. DB 마이그레이션 + 시드 데이터 생성 (최초 1회)

```bash
# 스키마 동기화(prisma db push)는 backend 컨테이너 시작 시 자동으로 실행됩니다. 시드만 별도 실행하세요.
docker compose -f docker-compose.prod.yml exec backend npm run seed
```

시드 계정(비밀번호 공통: `SAMPLE_pass1234` — **파일럿 종료 후 반드시 실제 계정/비밀번호 체계로 교체**):

| 이메일 | 역할 |
|---|---|
| sales1@sample.local | 영업직원 |
| eng1@sample.local | 엔지니어 |
| resident1@sample.local / resident2@sample.local | 고객사 상주자 |
| teamlead1@sample.local | 팀장(승인권한) |
| hr1@sample.local | 인사담당자 + 파일럿운영담당 |
| admin1@sample.local | 시스템관리자 |

---

## 6. 접속 확인

브라우저에서:
```
http://3.39.255.201:8001/login
```

API 헬스체크:
```
http://3.39.255.201:8001/api/v1/health
```

---

## 7. 방화벽/보안 체크리스트

- [x] 8001(HTTP)만 이 서비스에 필요 — 방화벽에 이미 열려 있는 8000-8001 규칙 범위에 포함되어 추가 작업 불필요 (80은 기존 서비스가 사용 중이라 피함)
- [ ] **정적 IP 연결 권장**: 현재 `3.39.255.201`은 인스턴스를 정지/시작하면 바뀔 수 있습니다(화면의 "Attach static IP" 버튼). Lightsail 콘솔에서 **Attach static IP**를 눌러 고정하는 것을 권장합니다(파일럿 도중 주소가 바뀌면 접속이 끊깁니다).
- [ ] 이 앱은 3000/4000 포트를 외부에 열 필요가 없습니다. 방화벽에 그 포트들이 열려있지 않다면 그대로 두세요.
- [ ] 스크린샷의 5432(PostgreSQL), 8000-8001, 5678-5679, 8501-8502, 5000-5002 규칙은 이 앱과 무관한 것으로 보입니다(다른 서비스용이라면 그대로 두고, 안 쓰는 규칙이면 최소 노출 원칙상 정리 권장).
- [ ] `.env.prod`의 `DB_PASSWORD` / `JWT_SECRET`을 예시값이 아닌 실제 값으로 반드시 교체
- [ ] 파일럿 종료 후 전사 확산 전에는 HTTPS(도메인+인증서) 적용 검토

---

## 8. 자주 쓰는 명령어

```bash
# 코드 갱신 후 재배포
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d

# 로그 확인
docker compose -f docker-compose.prod.yml logs -f

# 중지
docker compose -f docker-compose.prod.yml down

# DB는 유지한 채 중지(볼륨 삭제 안 함) — 위 down 명령이 기본값(볼륨 유지)
```

## 9. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 브라우저에서 접속 안 됨 | `docker compose -f docker-compose.prod.yml ps`로 nginx 컨테이너 Running 여부, Lightsail 방화벽 8001 규칙 |
| 로그인 후 API 오류 | `docker compose -f docker-compose.prod.yml logs backend`, `.env.prod`의 DATABASE_URL 값(자동 조합되므로 DB_PASSWORD만 맞으면 됨) |
| DB 관련 오류 | `docker compose -f docker-compose.prod.yml exec db psql -U app_user -d employee_status`로 직접 접속 확인 |
