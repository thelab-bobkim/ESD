# HTTPS_SETUP — 무료 도메인 + HTTPS(SSL) 설정 가이드

## 왜 필요한가

지금은 `http://3.39.255.201:8001`로 접속하는데, HTTP는 로그인 비밀번호와 로그인 토큰이
인터넷 구간에서 **암호화되지 않은 평문**으로 오갑니다. 사내망이 아니라 공인 IP로 열려있는
서버라 이 상태로 실제 인사정보(다우오피스 동기화 데이터 포함)를 다루는 건 위험합니다.
HTTPS를 붙이면 이 구간이 전부 암호화됩니다.

## 이 서버의 특수 상황

이 Lightsail 서버는 **80번 포트를 이미 다른 서비스(maintenance_system-web)가 쓰고 있어서**,
Let's Encrypt의 일반적인 인증서 발급 방식(80번 포트로 도메인 소유를 검증)을 못 씁니다.
대신 **443번 포트로 검증하는 방식(TLS-ALPN-01)**을 씁니다 — 443번은 이 서버에서 비어있고,
방화벽에도 이미 HTTPS 규칙으로 열려 있습니다. 기존 서비스는 전혀 건드리지 않습니다.

---

## 1단계: 무료 도메인 발급 (DuckDNS)

1. https://www.duckdns.org 접속 → 우측 상단에서 Google/GitHub 등으로 로그인
2. 원하는 서브도메인 입력 (예: `esd-회사이름`) → **add domain**
3. 만들어진 주소 확인: `esd-회사이름.duckdns.org`
4. **current ip** 칸에 서버의 공인 IP(`3.39.255.201`)를 입력하고 **update ip** 클릭
   - ⚠️ 이 IP가 나중에 바뀌면(인스턴스 재시작 등) 접속이 끊깁니다. Lightsail 콘솔에서
     **정적 IP(Static IP) 연결**을 꼭 해두는 것을 권장합니다(안 해두셨다면 이번 기회에 해두세요).

이제 `esd-회사이름.duckdns.org`가 서버 IP를 가리킵니다. 브라우저에서
`http://esd-회사이름.duckdns.org:8001/login`로 접속되는지 먼저 확인해보세요(아직 https 아님, 정상).

---

## 2단계: 서버에 certbot 설치

SSH 접속 후:

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
certbot --version
```

---

## 3단계: 인증서 발급 (443번 포트 검증 방식)

443번 포트가 비어있어야 검증이 되므로, **잠깐 nginx 컨테이너를 멈춥니다** (다른 컨테이너는 안 멈춤,
직원 화면 접속만 몇 분간 안 됨):

```bash
cd ~/employee-status-system
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml stop nginx
```

인증서 발급 (`esd-회사이름.duckdns.org`와 이메일 주소를 실제 값으로 바꿔서 실행):

```bash
sudo certbot certonly --standalone --preferred-challenges tls-alpn-01 \
  -d esd-회사이름.duckdns.org \
  -m 본인이메일@example.com --agree-tos --non-interactive
```

성공하면 `/etc/letsencrypt/live/esd-회사이름.duckdns.org/` 안에 인증서 파일이 생깁니다. 확인:

```bash
sudo ls /etc/letsencrypt/live/esd-회사이름.duckdns.org/
```

`fullchain.pem`, `privkey.pem`이 보이면 성공입니다.

---

## 4단계: nginx 설정에서 HTTPS 블록 활성화

```bash
nano nginx/default.conf
```

파일 아래쪽 `# ===== HTTPS ...` 이후 부분을 보면 전부 `#`으로 주석처리되어 있습니다.
1. **`YOUR_DOMAIN_HERE`를 전부 `esd-회사이름.duckdns.org`로 바꾸기** (Ctrl+`\`로 찾아바꾸기 가능, 또는 수동으로 4곳)
2. 그 블록의 **맨 앞 `#`을 전부 지우기** (주석 해제)

저장: `Ctrl+O` → Enter → `Ctrl+X`

(nano 대신 아래 명령어로 자동 처리도 가능합니다 — 도메인만 실제 값으로 바꿔서 한 번에 실행)
```bash
DOMAIN="esd-회사이름.duckdns.org"
sed -i "s/YOUR_DOMAIN_HERE/$DOMAIN/g" nginx/default.conf
sed -i '/# ===== HTTPS/,$ s/^# \{0,1\}//' nginx/default.conf
```

---

## 5단계: 환경변수 업데이트 + 재기동

```bash
nano .env.prod
```
`CORS_ORIGIN=` 줄을 찾아서 다음으로 채우기:
```
CORS_ORIGIN=https://esd-회사이름.duckdns.org
```

저장 후:
```bash
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

---

## 6단계: 확인

브라우저에서:
```
https://esd-회사이름.duckdns.org/login
```

자물쇠 아이콘이 보이고 "안전함"으로 나오면 성공입니다. 이제부터는 **이 https 주소를 기본으로 쓰시고**,
기존 `http://IP:8001` 주소는 필요할 때만 백업용으로 남겨두시면 됩니다.

---

## 7단계: 인증서 자동갱신 설정 (필수 — 90일마다 만료됨)

443번 포트 검증 방식이라 갱신할 때도 nginx를 잠깐 멈춰야 합니다. 자동화 스크립트를 만들어둡니다:

```bash
sudo tee /usr/local/bin/renew-esd-cert.sh > /dev/null << 'EOF'
#!/bin/bash
cd /home/ubuntu/employee-status-system
docker compose --env-file .env.prod -f docker-compose.prod.yml stop nginx
certbot renew --standalone --preferred-challenges tls-alpn-01 --non-interactive
docker compose --env-file .env.prod -f docker-compose.prod.yml start nginx
EOF
sudo chmod +x /usr/local/bin/renew-esd-cert.sh
```

매달 1일 새벽에 자동 실행되도록 등록(인증서는 만료 30일 전부터만 실제로 갱신되므로 매달 돌려도 안전합니다):

```bash
(sudo crontab -l 2>/dev/null; echo "0 4 1 * * /usr/local/bin/renew-esd-cert.sh >> /var/log/esd-cert-renew.log 2>&1") | sudo crontab -
```

---

## 참고: 다른 방법(Cloudflare Tunnel)도 있습니다

포트 문제를 아예 피하고 싶으시면 Cloudflare Tunnel이라는 방법도 있는데, 이건 도메인을
Cloudflare 네임서버로 옮겨야 해서(DuckDNS 도메인은 그대로 못 씀) 별도 도메인 구매나 설정이
더 필요합니다. 지금 방법(DuckDNS + certbot)이 가장 간단하고 완전 무료라 이걸 먼저 권장드립니다.
나중에 필요하시면 그 방법도 안내해드릴 수 있습니다.
