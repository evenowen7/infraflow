# Arsitektur InfraFlow

## Batas sistem

Browser → API Express → PostgreSQL. Worker terpisah membaca antrean di PostgreSQL, memanggil adapter, mengobservasi hasil, lalu menyimpan evidence. Browser tidak memegang credential runner atau menentukan URL/shell. DEMO berarti perubahan record simulasi PostgreSQL; bukan perubahan VM perusahaan. Qoder dipakai selama pengembangan, bukan runtime LLM.

## Identitas dan otorisasi

Password demo di-hash scrypt dengan salt acak. Cookie session opaque, HttpOnly, SameSite Strict; server menyimpan HMAC token session dan expiry. CSRF menggunakan token session dan Origin allowlist, termasuk perlindungan login. Role, status aktif, scope tim/environment dibaca dari database setiap request dan diulang sebelum dispatch. Login diberi rate limit per alamat dan input dibatasi 32 KiB. Secure cookie berlaku untuk origin HTTPS.

Requester hanya membuat/submit/cancel draft sendiri di scope timnya; anggota satu tim boleh membaca request tim. Approver terpisah harus memiliki scope resource. Operator hanya merekonsiliasi; platform admin tidak mendapat hak requester, approver, atau operator secara implisit. Auditor hanya membaca. Export memakai guard yang sama dengan detail. Credential tidak dikembalikan oleh endpoint user/settings.

## Request dan snapshot

Schema Zod strict mencegah field seperti role, environment palsu, shell, atau URL bebas masuk ke action. Environment resource berasal dari database. Request dibekukan pada submit; canonical JSON menghasilkan SHA-256. Approval terikat pada ID, version, hash, aktor, expiry. Parameter/jadwal yang berubah harus menjadi draft salinan baru; snapshot lama tidak diedit. Salinan dari hasil tidak pasti dilarang sebelum rekonsiliasi.

State transitions memakai map bersama dan compare-and-set. Approval dibuat dalam transaksi yang sama dengan transisi dan satu execution run. Unique key requester/idempotency key dan advisory transaction lock mencegah create ganda. Satu run per request sengaja lebih ketat daripada sekadar satu run aktif.

## Queue, lease, dan uncertainty

Worker claim memakai `FOR UPDATE SKIP LOCKED`, waktu `availableAt`, dan unique resource lock. Lock dimiliki run dan persisten melintasi restart proses. `NOT_DISPATCHED` → `DISPATCHING` dicatat sebelum memanggil adapter; operation ID dibuat lebih dahulu pada demo. Mutasi demo dan pencatatan hasil dispatch berada dalam transaksi PostgreSQL.

Worker memeriksa lease, akun, policy, target identity, catalog version, approval hash/expiry, jadwal, dan precheck lagi tepat sebelum mutasi. Timeout sesudah dispatch menghasilkan `REQUIRES_REVIEW`. Expired lease juga tidak menyebabkan redispatch; lock tetap ditahan. Tidak ada klaim exactly-once untuk sistem eksternal.

Rekonsiliasi operator mengambil observasi aktual demo, memeriksa verifier, mencatat alasan serta evidence tambahan, dan tidak mengirim mutasi. Request hasil tidak pasti tidak bisa dicancel atau diretry generik. Hasil yang diketahui boleh ditutup; hanya kemudian lock dibebaskan.

## Verifikasi dan bukti

Power on wajib memenuhi observed poweredOn dan guest/service health ketika resource mewajibkan. Target yang sudah sehat dan menyala menghasilkan `COMPLETED_NOOP` tanpa dispatch. Runner selesai dengan verifier gagal tidak menghasilkan `SUCCEEDED`. Evidence berisi mode, precheck, postcheck, correlation ID, hasil, dan waktu. Request detail menghubungkan aktor approval, audit, run events, operation ID, dan evidence.

Payload log/evidence/audit disanitasi sebelum persistensi, lalu disanitasi ulang saat export. Audit tidak punya API edit/delete; administrator database tetap dapat mengubah tabel, sehingga tidak diklaim tamper-proof.

## Restart dan provisioning

Graceful restart membutuhkan VM menyala, guest siap, dukungan guest reboot, health check yang dikonfigurasi dan sehat, serta boot marker awal. Evidence dispatch terikat operation ID dan target snapshot; verifier membandingkan boot marker sebelum/sesudah, identitas target, guest, dan health. Tidak ada hard reset atau fallback.

Create menerima catalog IDs dan metadata requester nonproduksi. Advisory lock nama adapter-wide dan quota tim melindungi validasi terakhir serta mutasi. Batas demo: 50 VM / 200 vCPU per tim. Snapshot menyimpan template, spesifikasi size, network, owner, environment; drift metadata membatalkan dispatch. Resource baru dan tautan request dibuat atomik, external ID berasal dari operation ID. Lock nama dialihkan atomik menjadi lock resource sebelum VERIFYING; lock tetap ditahan jika hasil tidak pasti. Verifier memerlukan bukti dispatch, external ID baru, seluruh spesifikasi cocok, serta bootstrap marker dan service sehat.

Snapshot target create tetap null sesudah provisioning; identitas hasil tersedia pada resource link dan evidence, bukan dengan mengubah snapshot yang telah disetujui. Salinan create mendapat nama baru bersufiks deterministik dari idempotency key, masih dapat diedit, dan tidak membawa approval lama.

## Simulator tiket dan outbox

DEMO_DESK menggunakan signature HMAC-SHA256 atas timestamp dan raw body, replay window lima menit, serta schema strict. Impor UI ditandatangani server; browser tidak mengetahui secret. Advisory locks dan unique inbox/provider-ticket constraints menduplikasi event identik ke request yang sama. Revisi baru/isi berubah ditolak untuk review, bukan dijalankan otomatis. Semua impor membutuhkan approval portal independen.

Hasil infrastruktur masuk outbox dalam transaksi finish. Sinkronisasi diklaim dengan row lock dan mencoba paling banyak tiga kali; operator hanya mengulangi outbox gagal. Pengiriman mengunci request otoritatif, tiket, lalu event untuk menjaga urutan hasil. Event hasil lama ditandai SUPERSEDED, tidak dikirim dan tidak menimpa hasil yang lebih baru. Rekonsiliasi menghasilkan evidence serta outbox baru tanpa mutasi VM.

## Operasional

Semua waktu PostgreSQL memakai TIMESTAMPTZ dan koneksi Prisma memaksa timezone UTC; JSON menggunakan ISO UTC, UI memakai Asia/Jakarta. Keduanya diperlukan agar query eligibility/lease terhadap NOW() tidak bergantung pada timezone server database. `/healthz` memeriksa liveness API dan `/readyz` menguji koneksi database. Polling UI hanya membaca progres; antrean tidak bergantung pada browser atau timer in-memory. Timer worker hanya menentukan interval polling.

Docker Compose memisahkan database, migration/seed, API, worker, dan web proxy. Deployment lokal hanya bind loopback. Connected adapter tetap nonaktif dan startup connected ditolak sampai implementasi terverifikasi tersedia. HA, SSO, backup, retensi, dan observability production merupakan pekerjaan pilot, bukan klaim MVP.
