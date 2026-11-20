import { test, expect, type Page, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { db } from '../../apps/api/src/db.js';

async function account(browser:Browser,name:string,errors:string[]) {
  const context=await browser.newContext({baseURL:process.env.E2E_BASE_URL??'http://localhost:5173',timezoneId:'America/Los_Angeles'});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByLabel('Alamat email').fill(`${name}@demo.infraflow.test`);
  await page.getByLabel('Password',{exact:false}).first().fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button',{name:'Masuk ke InfraFlow'}).click();
  await expect(page.getByRole('button',{name:'Keluar dari akun'})).toBeVisible();
  expect(process.env.APP_MODE).toBe('DEMO');expect(['localhost','127.0.0.1']).toContain(new URL(page.url()).hostname);
  return page;
}
async function submit(page:Page) {
  await page.getByRole('button',{name:'Lanjutkan'}).click();
  await page.getByLabel('Alasan operasional',{exact:false}).fill('Verifikasi browser untuk perubahan nonproduksi yang disetujui');
  await page.getByRole('button',{name:'Lanjutkan'}).click();
  await page.getByRole('button',{name:'Ajukan request',exact:true}).click();
  await expect(page).toHaveURL(/\/requests\/[a-f0-9-]+$/);
  await expect(page.locator('.request-status-strip')).toContainText('Menunggu persetujuan');
  return page.url().split('/').at(-1)!;
}
async function approve(page:Page,id:string) {
  await page.goto(`/requests/${id}`);await page.getByRole('checkbox',{name:/Saya telah meninjau snapshot/}).check();
  await page.getByLabel('Alasan keputusan').fill('Snapshot, scope, dan dampak telah ditinjau secara independen');
  await page.getByRole('button',{name:'Setujui request'}).click();
}
async function result(page:Page,id:string,status:string) {
  await expect.poll(async()=> (await (await page.request.get(`/api/requests/${id}`)).json()).status,{timeout:20000}).toBe(status);
  return (await page.request.get(`/api/requests/${id}`)).json();
}

test('create, graceful restart, editable clone and invalid catalog input in Chromium',async({browser})=>{
  const errors:string[]=[];const requester=await account(browser,'requester',errors);const approver=await account(browser,'approver',errors);
  const name=`e2e-created-${randomUUID().slice(0,8)}`;
  await requester.goto('/services');await requester.locator('.service-card').filter({has:requester.getByRole('heading',{name:'Buat VM',exact:true})}).getByRole('link',{name:'Buat request'}).click();
  await expect(requester.getByRole('button',{name:'Lanjutkan'})).toBeDisabled();
  await requester.getByLabel('Nama VM',{exact:false}).fill('Invalid Name');
  await requester.getByLabel('Template',{exact:false}).selectOption('ubuntu-24');
  await requester.getByLabel('Ukuran VM',{exact:false}).selectOption('small');
  await requester.getByLabel('Jaringan',{exact:false}).selectOption('net-platform');
  await expect(requester.getByRole('button',{name:'Lanjutkan'})).toBeDisabled();
  await expect(requester.locator('#create-environment option[value="PRODUCTION"]')).toHaveCount(0);
  await expect(requester.locator('#create-network option[value="net-data"]')).toHaveCount(0);
  await requester.getByLabel('Nama VM',{exact:false}).fill(name);
  const id=await submit(requester);
  await expect(requester.getByText('Belum ada · menunggu provisioning',{exact:true})).toBeVisible();
  await approve(approver,id);const created=await result(requester,id,'SUCCEEDED');
  expect(created.resource.name).toBe(name);expect(created.resource.cpu).toBe(2);
  expect(created.runs[0].evidence[0].postcheck.checks.specificationMatch).toBe(true);
  await requester.reload();await requester.getByRole('tab',{name:'Eksekusi & bukti'}).click();
  await expect(requester.getByText('Terverifikasi',{exact:true})).toBeVisible();
  await requester.screenshot({path:resolve('docs/screenshots/create-vm-evidence.png'),fullPage:true});
  await requester.goto(`/resources/${created.resourceId}`);await requester.getByRole('link',{name:'Restart VM',exact:true}).click();
  const restartId=await submit(requester);await approve(approver,restartId);
  const restarted=await result(requester,restartId,'SUCCEEDED');
  expect(restarted.resource.bootMarker).not.toBe(created.resource.bootMarker);
  expect(restarted.runs[0].evidence[0].postcheck.checks.bootMarkerChanged).toBe(true);
  expect(restarted.resource.mutationCount).toBe(2);
  await requester.goto(`/requests/${id}`);await requester.getByRole('button',{name:'Salin sebagai draf baru'}).click();
  await expect(requester).toHaveURL(/\/requests\/[a-f0-9-]+\/edit$/);
  await expect(requester.getByLabel('Nama VM',{exact:false})).toHaveValue(/-copy-[a-f0-9]{8}$/);
  const cloneId=requester.url().split('/').at(-2)!;await requester.getByLabel('Nama VM',{exact:false}).fill(`${name}-copy`);
  await requester.getByRole('button',{name:'Lanjutkan'}).click();await requester.getByRole('button',{name:'Lanjutkan'}).click();
  await requester.getByRole('button',{name:'Simpan draf'}).click();await expect(requester.locator('.request-status-strip')).toContainText('Draf');
  await requester.getByRole('button',{name:'Batalkan request'}).click();await requester.getByRole('button',{name:'Ya, batalkan'}).click();
  await expect(requester.locator('.request-status-strip')).toContainText('Dibatalkan');
  expect((await (await requester.request.get(`/api/requests/${cloneId}`)).json()).runs).toHaveLength(0);
  expect(errors).toEqual([]);await requester.context().close();await approver.context().close();
});

for(const scenario of ['NORMAL','TIMEOUT_AFTER_DISPATCH','VERIFY_FAIL']) {
  test(`ticket UI replay and ${scenario} with independent approval`,async({browser})=>{
    const errors:string[]=[];const operator=await account(browser,'operator',errors);const approver=await account(browser,'approver',errors);
    const suffix=randomUUID().slice(0,8);
    const target=await db.resource.create({data:{name:`e2e-ticket-${suffix}`,externalId:`e2e-ticket-${suffix}`,teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV',cpu:2,ramGb:4,diskGb:40,networkId:'net-platform'}});
    if(scenario!=='NORMAL') {
      await operator.goto(`/resources/${target.id}`);await operator.getByLabel('Skenario aksi berikutnya',{exact:false}).selectOption(scenario);
      await operator.getByRole('button',{name:'Simpan skenario demo'}).click();
      await expect(operator.getByRole('button',{name:'Simpan skenario demo'})).toBeDisabled();
    }
    await operator.goto('/tickets');await operator.getByLabel('Cari target VM',{exact:false}).fill(target.name);
    await operator.getByRole('button',{name:'Cari target',exact:true}).click();
    await expect(operator.locator(`#ticket-target option[value="${target.externalId}"]`)).toHaveCount(1);
    await operator.getByLabel('Target VM (external ID)',{exact:false}).selectOption(target.externalId);
    await operator.getByLabel('Alasan operasional tiket',{exact:false}).fill(`Pengujian browser tiket untuk skenario ${scenario}`);
    await operator.getByRole('button',{name:'Kirim event demo'}).click();
    const requestLink=operator.getByRole('link',{name:/^Buka request /});await expect(requestLink).toBeVisible();
    const requestHref=(await requestLink.getAttribute('href'))!;const id=requestHref.split('/').at(-1)!;
    const ticketHref=(await operator.getByRole('link',{name:/^Buka tiket /}).getAttribute('href'))!;
    await operator.getByLabel('Alasan operasional tiket',{exact:false}).fill('Kolom berubah tetapi replay harus mempertahankan payload awal');
    await operator.getByRole('button',{name:'Replay event yang sama'}).click();
    await expect(operator.getByText(/Replay terdeteksi:/)).toBeVisible();
    expect(await operator.getByRole('link',{name:/^Buka request /}).getAttribute('href')).toBe(requestHref);
    await operator.goto(ticketHref);
    if(scenario==='NORMAL') {
      await operator.getByRole('checkbox',{name:'Simulasikan kegagalan sinkronisasi tiket'}).check();
      await operator.getByRole('button',{name:'Simpan skenario tiket'}).click();
      await expect(operator.getByRole('button',{name:'Simpan skenario tiket'})).toBeDisabled();
    }
    await approve(approver,id);
    const expected=scenario==='NORMAL'?'SUCCEEDED':scenario==='VERIFY_FAIL'?'FAILED':'REQUIRES_REVIEW';
    const outcome=await result(operator,id,expected);expect(outcome.resource.mutationCount).toBe(1);
    if(scenario==='NORMAL') {
      await expect(operator.getByRole('button',{name:'Retry sinkronisasi tiket'})).toBeEnabled({timeout:20000});
      await operator.getByRole('checkbox',{name:'Simulasikan kegagalan sinkronisasi tiket'}).uncheck();
      await operator.getByRole('button',{name:'Simpan skenario tiket'}).click();
      await expect(operator.getByRole('button',{name:'Simpan skenario tiket'})).toBeDisabled();
      await operator.getByRole('button',{name:'Retry sinkronisasi tiket'}).click();
      await expect.poll(async()=> (await (await operator.request.get(`/api${ticketHref}`)).json()).syncStatus,{timeout:15000}).toBe('SYNCED');
      await operator.reload();await expect(operator.getByText('Tersinkron',{exact:true}).first()).toBeVisible();
      await operator.screenshot({path:resolve('docs/screenshots/ticket-sync.png'),fullPage:true});
    } else if(scenario==='TIMEOUT_AFTER_DISPATCH') {
      await operator.goto(requestHref);await operator.getByRole('tab',{name:'Eksekusi & bukti'}).click();
      await operator.getByLabel('Hasil yang dikonfirmasi',{exact:false}).selectOption('CONFIRMED_SUCCEEDED');
      await operator.getByLabel('Alasan & bukti pemeriksaan',{exact:false}).fill('Operator memeriksa observasi VM sehat dan bukti operasi yang tersimpan');
      await operator.getByRole('button',{name:'Konfirmasi rekonsiliasi'}).click();
      await expect(operator.locator('.request-status-strip')).toContainText('Berhasil');
      await operator.screenshot({path:resolve('docs/screenshots/reconciliation.png'),fullPage:true});
    }
    const final=await (await operator.request.get(`/api/requests/${id}`)).json();
    expect(final.resource.mutationCount).toBe(1);expect(final.runs).toHaveLength(1);
    expect(final.runs[0].evidence.some((e:{verified:boolean})=>e.verified)).toBe(scenario!=='VERIFY_FAIL');
    expect(errors).toEqual([]);await operator.context().close();await approver.context().close();
  });
}
