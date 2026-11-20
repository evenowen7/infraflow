# InfraFlow

Portal internal self-service infrastructure. **DEMO persisten**, bukan koneksi ke infrastruktur perusahaan. React/TypeScript + Vite, Express/TypeScript, Prisma 7 dengan PostgreSQL 16, dan worker terpisah. Tidak memerlukan API key model AI, Redis, vCenter, atau Jenkins.

## Fitur terverifikasi

- Power on → approval independen → worker → verification → evidence; no-op tidak mengubah VM.
- Graceful restart dengan bukti perubahan boot marker; create VM dengan katalog, quota, unique name, resource link, dan bootstrap verification.
- Draft/salin/cancel, jadwal WIB, RBAC tim/environment, snapshot immutable, queue/lease/lock persisten, uncertainty dan rekonsiliasi operator tanpa redispatch.
- Simulator tiket dengan signed webhook, replay dedupe, approval lokal, dan retry outbox terpisah dari operasi VM.
- Dashboard database-backed, inventory, approval inbox, audit, settings, dan export JSON. Semua berlabel DEMO.

Hasil akhir: **118 pengujian integrasi + 5 E2E Chromium lulus**; lint, typecheck, build, dan audit dependensi lulus. Rincian di [hasil pengujian](docs/test-results.md), [demo lima menit](docs/demo-guide.md), dan [batasan](docs/limitations.md).

## Mulai lokal

Prasyarat: Node.js 24, npm, PostgreSQL 16. Gunakan database khusus aplikasi, jangan database perusahaan.

```sh
npm ci
cp .env.example .env
# Isi DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET, WEBHOOK_SECRET, DEMO_PASSWORD.
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Buka http://localhost:5173. API http://localhost:3001 menyediakan `/healthz` dan `/readyz`. Seed aman diulang: **tidak** mereset VM, request, password, atau evidence yang sudah ada. Ganti password sebelum seed pertama melalui `DEMO_PASSWORD`, minimal 12 karakter. Secret minimal 32 karakter; misalnya hasil `openssl rand -hex 32`. `.env` tidak masuk git.

Database pada mesin pengembangan sesi ini dibuat khusus pada port **55432**, data di `.local/postgres`, database `infraflow` dan `infraflow_test`. Jika database sesi ini berhenti:

```sh
LC_ALL=C pg_ctl -D .local/postgres -l .local/postgres.log -o "-p 55432 -h 127.0.0.1 -k /tmp" start
```

Untuk membuat cluster lokal baru sendiri (jangan menjalankan ulang di direktori cluster yang sudah berisi data):

```sh
mkdir -p .local
LC_ALL=C initdb -D .local/postgres -E UTF8 --auth-local=trust --auth-host=scram-sha-256 --username=infraflow --pwprompt
LC_ALL=C pg_ctl -D .local/postgres -l .local/postgres.log -o "-p 55432 -h 127.0.0.1 -k /tmp" start
createdb -h /tmp -p 55432 -U infraflow infraflow
createdb -h /tmp -p 55432 -U infraflow infraflow_test
```

Gunakan password database yang dipilih dalam `DATABASE_URL` dan `TEST_DATABASE_URL`. URL-encode karakter khusus password pada URL koneksi. `LC_ALL=C` menghindari masalah locale PostgreSQL Homebrew pada mesin ini.

## Akun demo

Semua akun menggunakan nilai **`DEMO_PASSWORD` saat seed pertama**. Untuk konfigurasi lokal yang disiapkan dalam sesi ini nilainya `InfraFlow-Demo-2026!`; ini credential contoh, bukan credential perusahaan. Jangan gunakan kembali di connected/production.

| Email | Peran | Tim |
| --- | --- | --- |
| requester@demo.infraflow.test | Requester | Platform |
| approver@demo.infraflow.test | Approver | Platform |
| operator@demo.infraflow.test | Operator | Platform |
| admin@demo.infraflow.test | Platform Admin | Platform |
| auditor@demo.infraflow.test | Auditor | Platform |
| requester2@demo.infraflow.test | Requester | Data |

Tidak ada role selector. Session server-side, password scrypt, cookie HttpOnly/SameSite Strict dan CSRF token. Approver terpisah, scope tim/environment diperiksa backend. Admin tidak otomatis menjadi approver atau operator. Data `.test` dan subnet dokumentasi hanya contoh.

## Docker Compose

Isi `.env`, termasuk `POSTGRES_PASSWORD`, `SESSION_SECRET`, `WEBHOOK_SECRET`, dan `DEMO_PASSWORD`, lalu:

```sh
docker compose up --build
```

Buka http://localhost:8080. Services: `db`, `migrate` (migrasi dan seed satu kali), `api`, `worker`, `web`. Database antarkontainer memakai hostname **db**, bukan localhost. Volume `postgres_data` menyimpan data. Jangan gunakan `docker compose down -v` kecuali memang ingin menghapus seluruh data demo. Jangan isi `NODE_ENV=production` dengan credential demo; deployment connected/production harus memakai HTTPS dan identitas non-demo.

Docker tidak tersedia pada mesin sesi pengembangan ini; jalur Docker disediakan tetapi belum diuji runtime. Jalur PostgreSQL lokal dipakai untuk pengujian aktual.

## Perintah

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run start
npm run start:worker
npm run test:e2e
```

`start` dan `start:worker` menggunakan hasil build, dari direktori root. API hasil build juga dapat menyajikan `apps/web/dist`; origin harus sesuai alamat browser. E2E memakai konfigurasi Playwright dan browser Chromium (`npx playwright install chromium`). Pengujian integrasi wajib memakai `TEST_DATABASE_URL` dengan nama database berakhiran `_test`, terpisah dari demo.

## Struktur

- `apps/web`: antarmuka Indonesia, jadwal WIB, label DEMO tetap.
- `apps/api`: session, RBAC, katalog, request, approval, evidence, audit.
- `apps/worker`: queue PostgreSQL, lease, lock, dispatch, verification, recovery, outbox.
- `packages/contracts`: Zod schemas dan transition map.
- `packages/adapters`: interface inventory/execution/service desk/secret serta demo adapter.
- `prisma`: schema, migrasi SQL, seed idempotent.
- `tests`: pengujian perilaku dengan database terpisah.
- `docs`: arsitektur, API, demo, hasil checks, dan batasan.

## Keputusan dan asumsi

1. Satu organisasi, dua tim; akses requester mencakup resource/request tim, bukan hanya pemilik individu.
2. Snapshot tidak bisa diedit setelah submit. Gunakan salinan draft baru, approval lama tidak diwariskan. Salinan hasil tidak pasti diblokir sampai rekonsiliasi.
3. Satu execution run per request. Retry request baru hanya setelah outcome diketahui. Resource lock tetap ditahan ketika `REQUIRES_REVIEW`.
4. Approval berlaku 24 jam secara default; jadwal melampaui expiry ditolak. UTC disimpan, Asia/Jakarta ditampilkan.
5. Queue database-backed; lease habis **tidak** membuktikan operasi belum dikirim. Worker recovery berhenti untuk review, tidak melakukan dispatch ulang.
6. Power on memerlukan poweredOn dan guest/service health bila katalog mewajibkan. Sukses runner saja bukan sukses request.
7. Connected extension Jenkins adalah interface nonaktif `NOT_CONFIGURED`; tidak ada fallback ke demo dan tidak ada klaim integrasi nyata.
8. Audit append-only di API, bukan penyimpanan yang kebal administrator database. Retensi, backup, SSO, HA, dan SLA production belum ditetapkan.

Dokumentasi: [API](docs/api.md), [arsitektur](docs/architecture.md), [hasil pengujian](docs/test-results.md), [batasan](docs/limitations.md), dan [pekerjaan nyata menggunakan Qoder](docs/qoder-development-notes.md). Tidak ada deployment publik atau panggilan infrastruktur perusahaan.
