# Batasan yang diketahui

Status 19 November 2026: MVP **DEMO lokal**, bukan sistem production atau integrasi perusahaan.

## Integrasi

- VM merupakan record simulasi PostgreSQL. Power, boot marker, provisioning, health, dan evidence benar-benar berubah/persisten dalam simulator, tetapi tidak membuktikan perubahan hypervisor/guest nyata.
- JenkinsAdapter adalah extension typed yang selalu menolak `NOT_CONFIGURED`. Allowlisted jobs, credentials perusahaan, queue/build tracking, polling/callback terautentikasi, dan verifier provider nyata belum diimplementasikan/diuji. CONNECTED startup ditolak; tidak ada fallback ke DEMO.
- Service desk perusahaan, approval SERVICE_DESK, vCenter, Ansible, Terraform plan/apply/state lock, SSO/LDAP, dan secret vault belum terhubung. SecretProvider saat ini memakai environment server.
- DEMO_DESK hanya mengimpor POWER_ON_VM. Portal mendukung ketiga action; impor restart/create tiket belum tersedia. Revision baru memerlukan review dan ditolak, belum ada workflow pembaruan revision remote.
- Resize dan Kubernetes cluster hanya roadmap. Tidak ada runtime LLM atau klaim AI agentic.

## Kebijakan dan operasional

- Scope requester adalah tim/environment, bukan isolasi per individu. Akun admin tidak otomatis memperoleh role requester/approver/operator. Akun dan katalog dikelola melalui seed/database, belum ada UI administrasi identitas/kebijakan.
- Satu run per request; request yang mulai RUNNING tidak dapat dibatalkan. Expired lease selalu berhenti untuk review, termasuk intent yang belum terbukti terkirim. Tidak ada auto-retry infrastruktur atau klaim exactly-once external effects.
- Rekonsiliasi menggunakan alasan operator dan observasi backend; belum ada upload attachment atau ticket evidence file. Tidak ada notifikasi email/Slack; pengguna memantau halaman detail/polling.
- Nama create unik adapter-wide, termasuk reservasi draft. Quota sederhana 50 VM/200 vCPU per tim diperiksa terhadap resource pada validasi dan tepat sebelum mutasi; draft bukan reservasi kapasitas. Draft yang ditinggalkan masih mereservasi nama sampai dibatalkan.
- Observasi demo membaca state database; refresh memperbarui waktu observasi, bukan memanggil hypervisor. Health bersifat fixture terkontrol, bukan probe endpoint jaringan.
- Audit append-only hanya melalui API, tidak tamper-proof terhadap administrator database. Belum ada retensi otomatis, immutable archive, backup/restore drill, disaster recovery, atau SLA.
- Rate limit login/webhook bersifat per-process; session/queue/evidence persisten, tetapi rate limit bukan distributed limiter. Expired session belum memiliki cleanup scheduler. Pool connection/observability/HA perlu diuji sebelum pilot.
- Redaksi berbasis struktur key dan pola secret umum, bukan pendeteksi seluruh secret yang mungkin disisipkan dalam teks bebas. Jangan memasukkan credential nyata ke alasan, log, atau data demo.
- DEMO dengan NODE_ENV=production ditolak. PostgreSQL pengembangan disimpan lokal; mekanisme trust Unix socket hanya untuk mesin pengembangan, bukan production. Jangan mengekspos instalasi ini ke publik.

## Validasi lingkungan

- Docker Compose dan Dockerfile tersedia tetapi belum diuji runtime karena Docker tidak terpasang pada mesin ini. Pengujian aktual memakai PostgreSQL 16 lokal, API/worker terpisah, dan Vite.
- Chromium Playwright diuji; browser bawaan Qoder tidak mempunyai viewport aktif. Safari/WebKit, Firefox, screen reader, dan audit aksesibilitas formal belum dijalankan.
- Pengujian 500 resource merupakan pengukuran Supertest in-process HTTP + PostgreSQL lokal tanpa beban paralel pengguna, bukan load test deployment atau klaim SLA.
- Suite mengeluarkan deprecation warning driver pg terkait query bersamaan pada client. Seluruh test lulus pada versi terkunci; kompatibilitas dengan major pg berikutnya belum diuji. Jangan melakukan upgrade mayor tanpa regression suite.
- E2E menambahkan resource dan request demo baru agar dapat diulang tanpa mereset bukti lama. Pengulangan sangat banyak dapat mencapai quota demo; gunakan database demo baru, bukan menghapus data pengguna.

Prioritas pilot: otorisasi organisasi, threat model/penetration test, kontrak provider dan health verifier nyata, secret management, backup/retensi, observability dan load test, kemudian validasi staging sebelum akses produksi.
