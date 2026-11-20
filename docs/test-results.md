# Hasil pengujian InfraFlow

Dijalankan pada **19 November 2026** di macOS arm64, Node **24.21.0**, npm **11.19.0**, PostgreSQL **16.14 (Homebrew)**, Prisma **7.10.1**, Vitest **5.1.1**, Vite **7.3.8**, Chromium melalui Playwright. Hasil ini untuk DEMO lokal, bukan infrastruktur perusahaan.

## Urutan wajib

Vertical slice POWER_ON_VM diselesaikan lebih dahulu. Pada gate awal, **52 integration tests dan satu E2E power on/no-op** lulus sebelum restart/create dikembangkan. Dua kegagalan awal—jadwal dieksekusi dini dan lease aktif dianggap expired—direproduksi dan diperbaiki dengan TIMESTAMPTZ serta timezone UTC pada koneksi PostgreSQL. Suite akhir menambah regresi konfigurasi production dan redaksi response.

## Checks akhir

Perintah berurutan yang benar-benar dijalankan:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm audit
npm run test:e2e
```

| Check | Hasil |
| --- | --- |
| Migrasi database test | 3 migrasi terpasang, tidak ada pending migration |
| Vitest | **118 lulus**, 5 file, 45,95 detik |
| TypeScript API/worker/web | Lulus |
| ESLint | Lulus |
| Build server + Vite | Lulus |
| npm audit | **0 vulnerabilities** pada lockfile saat diperiksa |
| Playwright Chromium | **5 lulus**, 25,5 detik |
| Migrasi/seed demo diulang | Lulus; resource/request/evidence lama tidak direset |
| Compiled API smoke + static web | Lulus, listener sementara loopback port 3002 |
| Session setelah restart API | Lulus; cookie yang sama tetap valid; jumlah request/resource tidak berubah |

API smoke menjalankan hasil `dist/apps/api/src/index.js`, memeriksa `/readyz`, HTML frontend, login, dan dashboard; menghentikan proses milik pengujian dengan SIGTERM lalu memulai proses baru. Session persisten masih valid; scope requester tetap 22 request / 19 resource pada saat pemeriksaan. Listener sementara dihentikan; API/worker/web pengembangan tetap tersedia pada port 3001/5173.

## Cakupan integrasi

- `tests/power-on.test.ts` — **54**: request → approval berbeda → claim → dispatch → verification → evidence; no-op tanpa mutasi; self approval multi-role, cross-team/read/mutate/export, auditor/admin restrictions, Origin/CSRF/session, payload production, immutable/hash mismatch, role/scope/active/catalog drift, expiry, concurrent idempotency/submit/approval, competing workers, cancellation, WIB/schedule/lease, timeout, failure, reconciliation, redaksi log/error/export/response, connected refusal, database uniqueness.
- `tests/actions.test.ts` — **53**: restart dengan boot-marker proof, guest/health prerequisites, larangan hard reset, create sesuai snapshot metadata/catalog, owner/network/scope/name/quota, competing create/quota locks, drift, kegagalan verifier, timeout/recovery/reconciliation tanpa dispatch ulang, lock resource setelah provisioning, stable clone idempotency, dan seed repeatability.
- `tests/tickets.test.ts` — **9**: HMAC dan timestamp, replay simultan, event/revision conflicts, requester mapping/scope, approved claim tidak menggantikan approval lokal, kegagalan sync dengan outbox-only retry, hasil review terlambat menjadi SUPERSEDED, serta callback tidak didukung tidak mengubah terminal state.
- `tests/worker-restart.test.ts` — **1**: Node process pertama menulis durable dispatch intent dan lease expired lalu berhenti; process kedua menjalankan recovery. Approval/run/evidence/lock bertahan, tidak ada redispatch atau mutasi target. Ini simulasi crash-window melalui proses berbeda, bukan uji power-loss host/database.
- `tests/performance.test.ts` — **1**: 500 resource PostgreSQL, list/detail scoped terautentikasi, threshold p95 < 2.000 ms.

## Browser dan inspeksi visual

1. Create dari katalog, input/nama tidak valid, production/network di luar scope tidak tersedia, approval independen, evidence, graceful restart dengan boot marker berubah, clone dapat diedit dan dibatalkan tanpa run.
2. Import tiket normal dan replay dengan field UI yang sudah berubah tetap memakai payload awal; infrastruktur sukses, ticket sync gagal tiga kali, retry hanya outbox setelah skenario diperbaiki.
3. Timeout setelah dispatch → REQUIRES_REVIEW → rekonsiliasi operator → sukses tanpa efek kedua.
4. Verifier gagal → FAILED, bukan sukses.
5. Power on → approval berbeda → verified evidence/download; request kedua no-op, navigasi halaman utama, mobile 390px tanpa horizontal overflow.

Context requester/approver/operator terpisah; tidak mengganti role browser. Pengujian memeriksa `pageerror` dan tidak menemukan exception halaman. Screenshot aktual telah dibaca untuk inspeksi visual:

- [Dashboard](screenshots/dashboard.png)
- [Power-on evidence](screenshots/power-on-evidence.png)
- [Create VM evidence](screenshots/create-vm-evidence.png)
- [Ticket synchronization](screenshots/ticket-sync.png)
- [Reconciliation](screenshots/reconciliation.png)

Browser bawaan Qoder gagal karena viewport tidak aktif (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`); bukan hasil lulus manual. Interaksi actual browser dilakukan dengan Chromium Playwright. Browser lain dan audit aksesibilitas formal belum dijalankan.

## Pengukuran 500 resource

Fixture menambahkan 488 resource pada 12 seed, total **500**. Sepuluh warm-up diikuti 50 pengukuran per endpoint menggunakan Supertest HTTP in-process dengan PostgreSQL lokal. Satu user/permintaan berurutan, bukan uji load paralel atau latensi deployment.

| Endpoint | p95 run akhir |
| --- | ---: |
| `/api/resources?pageSize=100` | **4,76 ms** |
| `/api/resources/perf-0` | **3,64 ms** |

Angka bervariasi antar-run dan tidak menjadi klaim SLA/performa perusahaan.

## Pengulangan dan batasan

`npm test` menerapkan migrasi pada TEST_DATABASE_URL lalu menjalankan fixture reset terjaga; nama database wajib berakhiran `_test`, database aktif diperiksa sebelum truncate. Ini tetap pengujian destruktif pada database test khusus—jangan arahkan ke data penting. E2E menambah data demo baru tanpa menghapus evidence lama.

Docker runtime belum diuji karena Docker tidak terpasang. Connected Jenkins/ITSM/SSO/Terraform tidak diuji dan tetap NOT_CONFIGURED. Driver pg mengeluarkan satu deprecation warning query bersamaan; tidak ada test failure, tetapi kompatibilitas major berikutnya belum diverifikasi. Tidak ada deployment publik, submission, atau akses perusahaan. Lihat [batasan](limitations.md).
