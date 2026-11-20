# API InfraFlow

Base `/api`. JSON; request maksimal 32 KiB. Login dan mutasi harus menyertakan `Origin` yang sama dengan `APP_ORIGIN`. Setelah login, kirim cookie session dan `X-CSRF-Token` dari response login/current-user. Role tidak diterima dari payload/header. Response error `{error, code}`; validasi menambahkan `issues` tanpa nilai input sensitif.

## Endpoint

| Method | Path | Perilaku |
| --- | --- | --- |
| GET | `/healthz`, `/readyz` | Publik; liveness/kesiapan database |
| POST | `/auth/login` | `{email,password}` → `{user,csrfToken,mode}` |
| GET | `/me` | Identitas session dan CSRF |
| POST | `/auth/logout` | Hapus session; 204 |
| GET | `/catalog` | Services, templates, sizes, networks sesuai scope |
| GET | `/resources` | `q`, `environment`, `page`, `pageSize` |
| GET | `/resources/:id` | Resource sesuai scope |
| POST | `/resources/:id/refresh` | Refresh timestamp observasi adapter DEMO |
| POST | `/resources/:id/scenario` | Operator/admin, DEMO saja; `{scenario}` |
| POST | `/requests` | Buat draft; wajib `Idempotency-Key` 8–128 karakter |
| PATCH | `/requests/:id` | Hanya draft milik pemohon; field tervalidasi |
| POST | `/requests/:id/submit` | Precheck dan bekukan snapshot |
| POST | `/requests/:id/decision` | `{decision:"APPROVE"\|"REJECT", reason}`; approver berbeda |
| POST | `/requests/:id/cancel` | Pemohon; hanya sebelum RUNNING |
| POST | `/requests/:id/clone` | Salinan DRAFT baru tanpa approval; Idempotency-Key wajib |
| GET | `/requests` | Filter `status`, `action`, pagination |
| GET | `/requests/:id` | Snapshot, resource, approval, run/events/evidence, audit, ticket |
| GET | `/requests/:id/evidence` | Download JSON scoped dengan label mode |
| GET | `/approvals` | Approval inbox sesuai role/scope |
| GET | `/runs/:id` | Detail run/events/evidence sesuai scope request |
| POST | `/runs/:id/reconcile` | Operator; alasan dan outcome, observasi backend, tanpa dispatch |
| GET | `/dashboard` | Counts/durasi/recent requests dari database |
| GET | `/audit` | Scoped read-only, pagination |
| GET | `/audit/export` | JSON scoped; maksimum 1.000 event terakhir dinyatakan di response |
| GET | `/tickets` | Scoped ticket list/sync status |
| POST | `/tickets/demo` | Operator/admin, import payload simulator; signature dibuat server-side |
| GET | `/tickets/:id` | Mapping request, inbox events, outbox, sync attempts/result |
| POST | `/tickets/:id/scenario` | Operator/admin DEMO; `{simulateSyncFailure:boolean}` |
| POST | `/tickets/:id/sync-retry` | Operator; hanya ulang outbox gagal, bukan infrastruktur |
| POST | `/webhooks/demo` | Raw JSON HMAC terautentikasi, tanpa browser session |
| GET | `/settings` | Readiness adapter, policy nonrahasia, kesehatan DB |

List response `{items,total,page,pageSize,mode}`. Default 20 item, maksimum 100. Current-user tidak mengembalikan password hash maupun session token.

## Power on

```json
{
  "action": "POWER_ON_VM",
  "resourceId": "vm-1",
  "reason": "Menyiapkan layanan pengujian nonprod",
  "parameters": {},
  "scheduledAt": null
}
```

Environment diambil dari katalog resource, bukan body. Alasan minimum 10 karakter. Jadwal optional ISO 8601 dengan offset; kirim UTC hasil konversi input WIB. Field tidak dikenal, arbitrary command, dan URL user ditolak. Draft/create tidak melakukan mutasi VM.

Rekonsiliasi menggunakan `{reason, outcome:"CONFIRMED_SUCCEEDED"|"CONFIRMED_FAILED"}`. Backend tetap memeriksa observasi. Keputusan sukses tanpa verifier yang memenuhi kontrak ditolak. Endpoint tidak memulai run baru.

Scenario DEMO yang diizinkan: `NORMAL`, `VERIFY_FAIL`, `TIMEOUT_AFTER_DISPATCH`, `SECRET_LOG`. Requester tidak bisa mengubah scenario. Scenario tidak menjadi parameter action/approval dan tidak dapat digunakan pada connected.

## Graceful restart dan create VM

Restart memakai bentuk request power on dengan `action:"RESTART_VM"`. Parameter wajib objek kosong; tidak menerima `force`, `hardReset`, script, atau flag health. Backend menolak VM mati, guest tidak siap/tidak mendukung reboot, health tidak dikonfigurasi/tidak sehat, atau boot marker tidak diketahui. Sukses memerlukan boot marker berubah dan bukti dispatch yang cocok, bukan sekadar VM menyala.

Contoh create (tanpa `resourceId`):

```json
{
  "action": "CREATE_VM",
  "reason": "Menyediakan aplikasi staging untuk pengujian rilis",
  "scheduledAt": null,
  "parameters": {
    "name": "staging-api-01",
    "templateId": "ubuntu-24",
    "sizeId": "small",
    "networkId": "net-platform",
    "teamId": "team-platform",
    "owner": "requester@demo.infraflow.test",
    "environment": "DEV"
  }
}
```

Nama 3–40 karakter `[a-z][a-z0-9-]{2,39}`, unik adapter-wide termasuk reservasi request aktif/draft. Owner harus requester aktif dalam scope yang sama; network milik tim. Hanya DEV/TEST, 50 VM dan 200 vCPU per tim. Catalog IDs dan spesifikasi diperiksa ulang sebelum dispatch. Resource ditautkan setelah mutasi provisioning; snapshot tetap immutable. Salinan create memiliki nama `nama-copy-<suffix>` yang dapat diedit; replay clone dengan key sama mengembalikan draft yang sama.

## Simulator service desk

Payload import berisi `provider:"DEMO_DESK"`, `eventId`, `externalTicketId`, `revision`, `requesterEmail`, `action:"POWER_ON_VM"`, `targetExternalId`, `reason`, `approvalSource:"PORTAL"`. Identitas target memakai external ID unik pada adapter demo, bukan nama tampilan. Claim `approved:true` tidak memberikan approval. `SERVICE_DESK` ditolak karena provider otoritatif perusahaan belum tersedia.

Webhook memakai header `X-InfraFlow-Timestamp` (Unix seconds, toleransi ±300 detik) dan `X-InfraFlow-Signature` (hex HMAC-SHA256 dari `timestamp + "." + rawJsonBytes` memakai `WEBHOOK_SECRET`). Body dan signature harus cocok sebelum event diterima. Secret tidak dikirim ke browser. Endpoint dibatasi 60 request/menit per IP secara default.

Unique inbox `(provider,eventId)` dan unique ticket `(provider,externalId)` diserialisasi dalam transaksi. Replay identik mengembalikan `{requestId,ticketId,replayed:true,mode:"DEMO"}`. Event ID sama dengan isi berbeda, isi revision sama berubah, serta revision baru pada tiket lama menghasilkan konflik; tidak memulai run baru. Import pertama langsung membuat snapshot menunggu approval lokal, tanpa dispatch.

Ticket `syncStatus` terpisah dari `Request.status`. Outbox mencoba hingga tiga kali dengan backoff terbatas. Jika gagal, operator dapat memperbaiki simulator kemudian mengulangi sinkronisasi; status dan mutasi VM tidak diulang. Outbox hasil yang sudah tidak sesuai dengan status request otoritatif ditandai `SUPERSEDED` tanpa pengiriman; hasil lama tidak dapat menimpa hasil rekonsiliasi terbaru.

## Status HTTP

- 200/201: hasil baca/mutasi atau draft baru/replay idempotent.
- 401: session/credential tidak valid.
- 403: role/scope/CSRF/origin/production ditolak.
- 404: objek/endpoint tidak tersedia.
- 409: snapshot/status/idempotency/concurrency konflik.
- 410: approval kedaluwarsa pada guard eksekusi.
- 422: payload, prerequisite, jadwal, atau verifikasi tidak valid.
- 429: rate limit login.
- 503: adapter/action belum dikonfigurasi; tidak fallback.

Tidak ada PATCH status generik, endpoint menjalankan shell, edit/delete audit, hard reset, force power off, atau callback connected yang menerima status sukses tanpa verifier.
