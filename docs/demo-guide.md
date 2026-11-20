# Demo InfraFlow sekitar lima menit

Gunakan hanya data **DEMO**. Tidak ada koneksi ke infrastructure perusahaan. Password akun demo berasal dari `DEMO_PASSWORD` saat seed pertama; lihat README untuk konfigurasi lokal sesi ini.

## Persiapan

1. Jalankan migration, seed, API, worker, dan web (`npm run dev`). Periksa `/readyz`.
2. Siapkan dua browser context/profile terpisah untuk requester dan approver, atau logout/login bergantian. Tidak ada dropdown pemalsuan role.
3. Pilih VM nonprod yang `poweredOff`, scenario `NORMAL`, dan team Platform. VM production hanya untuk memperlihatkan larangan policy.
4. Data demo persisten: seed ulang tidak mematikan VM atau menghapus evidence. Untuk mengulang demo gunakan VM off lain atau environment database demo baru.

## Alur utama

**0:00–0:45 — Request**

Masuk sebagai `requester@demo.infraflow.test`. Buka Layanan → Nyalakan VM, pilih target, isi alasan, pilih setelah disetujui, tinjau ringkasan, dan Ajukan request. Tunjukkan snapshot, hash/version, jadwal WIB, dan status menunggu persetujuan. Tidak ada mutasi saat submit.

**0:45–1:30 — Approval independen**

Masuk sebagai `approver@demo.infraflow.test`. Buka Approval, detail request, tinjau snapshot/target/dampak/precheck, centang konfirmasi review, tulis alasan keputusan, lalu Setujui request. Pemohon tidak dapat menyetujui request sendiri.

**1:30–2:30 — Execution, verification, evidence**

Buka tab Eksekusi & bukti. Tunjukkan run ID, operation ID, log claim → dispatch → verifying → succeeded, correlation ID, observed power state, guest/service checks, dan evidence berlabel DEMO. Unduh JSON evidence. Resource berubah di PostgreSQL, bukan animasi browser.

Ajukan power on untuk target yang sama. Setelah approval lain, hasil `COMPLETED_NOOP` tidak menambah mutasi. Jelaskan bahwa no-op bukan restart.

**2:30–3:40 — Replay tiket**

Sebagai operator, buka Service Desk dan import tiket demo terstruktur. Target menggunakan external resource ID. Import tetap membutuhkan approval lokal. Replay payload/event identik: UI menunjukkan replay, ID request tetap sama, tidak ada job kedua. Revisi atau isi berbeda memerlukan rekonsiliasi, bukan eksekusi ulang otomatis.

**3:40–4:40 — Hasil tidak pasti**

Sebagai operator, pada resource nonprod yang masih off, pilih scenario `TIMEOUT_AFTER_DISPATCH`. Buat request dan dapatkan approval biasa. Tunjukkan `REQUIRES_REVIEW`, resource lock tetap ditahan, dan tidak ada tombol retry infrastruktur. Operator melakukan rekonsiliasi dengan alasan; backend memeriksa observasi dan mencatat evidence tambahan tanpa mutasi ulang.

Alternatif: pilih `VERIFY_FAIL` untuk memperlihatkan runner selesai tetapi service check gagal, sehingga request tidak sukses. Kembalikan scenario menjadi `NORMAL` setelah demo jika lock telah dilepas; perubahan scenario tidak mematikan/mereset VM.

**4:40–5:00 — Batas sistem**

Settings menyatakan Jenkins dan service desk perusahaan `NOT_CONFIGURED`. Resize dan cluster merupakan roadmap, tanpa tombol execute palsu. Tidak ada AI runtime, secret perusahaan, atau klaim penghematan yang belum diukur. Restart berarti graceful guest reboot; create menggunakan template standar, bukan shell bebas.

## Tambahan: restart dan create

- **Restart:** sebagai requester buka VM nonprod menyala, guest siap, sehat, dan guest reboot didukung → Restart VM. Submit dan setujui dengan akun approver lain. Pada evidence tunjukkan `bootMarkerChanged`, `dispatchProof`, `sameTarget`, dan service health. VM tanpa guest support tidak memiliki opsi hard reset.
- **Create:** Layanan → Buat VM. Isi nama unik, template, ukuran, network tim, owner requester aktif, dan DEV/TEST. Setelah approval, resource baru terhubung ke request. Evidence membuktikan external ID baru, spesifikasi sesuai snapshot, dan bootstrap siap. Sebelum provisioning resource ID null merupakan kondisi valid.
- **Salinan create:** tombol Salin sebagai draf baru menghasilkan nama bersufiks baru yang dapat diedit; approval lama tidak diwariskan. Batalkan draft yang tidak dibutuhkan agar reservasi namanya dilepas.
- **Ticket sync failure:** sebelum approval tiket, operator mengaktifkan Simulasikan kegagalan sinkronisasi tiket. Setelah VM sukses, tunggu tiga percobaan outbox menjadi gagal. Matikan skenario lalu Retry sinkronisasi tiket. Run dan mutationCount tidak bertambah; hasil VM tetap sukses.

Screenshot berasal dari pengujian browser nyata di `docs/screenshots`: power-on-evidence, create-vm-evidence, ticket-sync, reconciliation, dan dashboard. Payload JSON panjang memiliki area scroll; unduh evidence untuk melihat seluruh bukti.

## Mengulang dengan aman

- Pilih target nonprod off lain; seed hanya menambahkan data yang belum ada.
- Untuk baseline kosong, buat database **baru** bernama berbeda, atur `DATABASE_URL`, jalankan migrasi/seed, dan restart semua proses. Simpan database lama untuk evidence.
- Jangan truncate database demo yang berisi pekerjaan pengguna; jangan menghapus volume Docker untuk sekadar memperbaiki error.
- `npm test` mereset **hanya** database yang dinyatakan `TEST_DATABASE_URL` dan namanya berakhiran `_test`. Pastikan ini bukan database yang ingin dipertahankan.
- Browser E2E menambahkan fixture/request DEMO tersendiri; tidak menghapus evidence yang sudah ada.

## Yang akan diukur saat pilot

Baseline waktu fulfilment, jumlah request lengkap saat diajukan, frekuensi duplikasi, waktu approval, frekuensi rekonsiliasi, dan kegagalan ticket sync. Angka penghematan organisasi belum diukur.
